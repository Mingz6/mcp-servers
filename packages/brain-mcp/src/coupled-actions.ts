import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { createLogger } from "./logger.js";

const log = createLogger("coupled-actions");

interface CoupledAction {
  id: string;
  trigger: string;
  description: string;
  actions: string[];
  severity: "hard" | "soft";
}

interface CoupledActionsConfig {
  coupled_actions: CoupledAction[];
}

let cached:
  | { mtimeMs: number; configPath: string; actions: CoupledAction[] }
  | undefined;

function getConfigPath(): string {
  return path.join(
    process.env["BRAIN_MCP_ROOT"] ?? "",
    "copilot",
    "config",
    "coupled-actions.yml",
  );
}

function loadCoupledActions(): CoupledAction[] {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    if (cached?.configPath !== configPath) {
      log.warn("coupled-actions.yml not found", { configPath });
    }
    cached = { mtimeMs: 0, configPath, actions: [] };
    return [];
  }

  let mtimeMs = 0;
  try {
    mtimeMs = statSync(configPath).mtimeMs;
  } catch {
    // best-effort; fall through
  }

  if (cached && cached.configPath === configPath && cached.mtimeMs === mtimeMs) {
    return cached.actions;
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = parseYaml(raw) as CoupledActionsConfig;
    const actions = config?.coupled_actions ?? [];
    log.info("Loaded coupled-actions.yml", { rules: actions.length, configPath });
    cached = { mtimeMs, configPath, actions };
    return actions;
  } catch (err) {
    log.error("Failed to parse coupled-actions.yml", err, { configPath });
    cached = { mtimeMs, configPath, actions: [] };
    return [];
  }
}

function matchesTrigger(taskDescription: string, trigger: string): boolean {
  const patterns = trigger
    .split("|")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const desc = taskDescription.toLowerCase();
  return patterns.some((p) => desc.includes(p));
}

// --- Action satisfaction: token-overlap with stemming + stopwords ---
const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "in", "and", "or", "on", "at", "by", "for", "with",
  "is", "are", "was", "were", "be", "been", "being",
  "must", "should", "shall", "can", "could", "may", "might", "will", "would",
  "this", "that", "these", "those", "it", "its",
  "if", "then", "else", "when", "where",
  "any", "all", "applicable", "relevant", "needed", "required",
]);

function stem(word: string): string {
  if (word.length <= 3) return word;
  let w = word;
  // Apply suffix rules in priority order (only one matches).
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("es") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) w = w.slice(0, -1);
  // Also strip trailing single 'e' if still long enough — unifies pairs like
  // "update" ↔ "updat" (from "updated"), "compile" ↔ "compil" (from "compiled"),
  // "table" ↔ "tabl" (from "tables"). Preserve "ee" endings (tree, see).
  if (w.length >= 5 && w.endsWith("e") && !w.endsWith("ee")) {
    w = w.slice(0, -1);
  }
  return w;
}

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map(stem)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

/**
 * Tokens match if equal, or one is a 3+ char prefix of the other.
 * Catches stem pairs the simple suffix-stripper misses, e.g.
 *   "doc" ↔ "documentation", "test" ↔ "testing", "updat" ↔ "updates".
 * Word length ≥ 3 keeps "to", "in", "is" etc. (already stopwords) from
 * fanning out; the stopword list filters those before this runs anyway.
 */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 3 && b.startsWith(a)) return true;
  if (b.length >= 3 && a.startsWith(b)) return true;
  return false;
}

/**
 * An action requirement is satisfied if at least 50% of its content tokens
 * (after stopword removal + stemming) appear in any single action taken.
 * Always requires at least 2 token overlaps unless the requirement itself
 * has fewer than 2 content tokens.
 */
export function actionSatisfied(required: string, actionsTaken: readonly string[]): boolean {
  const reqTokens = tokenize(required);
  if (reqTokens.size === 0) return true;

  const minOverlap = Math.max(
    Math.min(2, reqTokens.size),
    Math.ceil(reqTokens.size * 0.5),
  );

  for (const taken of actionsTaken) {
    const takenTokens = tokenize(taken);
    let overlap = 0;
    for (const t of reqTokens) {
      for (const k of takenTokens) {
        if (tokensMatch(t, k)) {
          overlap++;
          break;
        }
      }
    }
    if (overlap >= minOverlap) return true;
  }
  return false;
}

export interface PreflightResult {
  matchedActions: Array<{
    id: string;
    description: string;
    actions: string[];
    severity: "hard" | "soft";
  }>;
}

export function preflight(taskDescription: string): PreflightResult {
  const all = loadCoupledActions();
  const matched = all.filter((a) => matchesTrigger(taskDescription, a.trigger));
  return {
    matchedActions: matched.map((a) => ({
      id: a.id,
      description: a.description,
      actions: a.actions,
      severity: a.severity,
    })),
  };
}

export interface VerifyResult {
  passed: boolean;
  missing: Array<{
    id: string;
    description: string;
    missingActions: string[];
    severity: "hard" | "soft";
  }>;
  hardFail: boolean;
}

export function verifyCompletion(
  taskDescription: string,
  actionsTaken: string[],
): VerifyResult {
  const { matchedActions } = preflight(taskDescription);

  const missing: VerifyResult["missing"] = [];

  for (const rule of matchedActions) {
    const missingActions = rule.actions.filter(
      (required) => !actionSatisfied(required, actionsTaken),
    );

    if (missingActions.length > 0) {
      missing.push({
        id: rule.id,
        description: rule.description,
        missingActions,
        severity: rule.severity,
      });
    }
  }

  const hardFail = missing.some((m) => m.severity === "hard");
  return { passed: missing.length === 0, missing, hardFail };
}

// Test-only: drop the in-memory cache so the next call re-reads from disk.
export function _resetCacheForTesting(): void {
  cached = undefined;
}
