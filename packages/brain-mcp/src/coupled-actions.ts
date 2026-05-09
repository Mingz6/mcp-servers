import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

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

let cachedActions: CoupledAction[] | null = null;

function loadCoupledActions(): CoupledAction[] {
  if (cachedActions) return cachedActions;

  const configPath = path.join(
    process.env["BRAIN_MCP_ROOT"] ?? "",
    "copilot",
    "config",
    "coupled-actions.yml",
  );

  if (!existsSync(configPath)) return [];

  const raw = readFileSync(configPath, "utf-8");
  const config = parseYaml(raw) as CoupledActionsConfig;
  cachedActions = config.coupled_actions ?? [];
  return cachedActions;
}

function matchesTrigger(taskDescription: string, trigger: string): boolean {
  const patterns = trigger.split("|").map((p) => p.trim().toLowerCase());
  const desc = taskDescription.toLowerCase();
  return patterns.some((p) => desc.includes(p));
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
  const takenLower = actionsTaken.map((a) => a.toLowerCase());

  const missing: VerifyResult["missing"] = [];

  for (const rule of matchedActions) {
    const missingActions = rule.actions.filter((required) => {
      const reqLower = required.toLowerCase();
      return !takenLower.some(
        (taken) => taken.includes(reqLower) || reqLower.includes(taken),
      );
    });

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
