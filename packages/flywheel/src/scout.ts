import {
    compareCommits,
    getLatestSha,
    searchRepos
} from "./github.js";
import {
    getActiveRepos,
    loadRepos,
    saveRepos,
    updateRepoAfterCheck,
    type Repo
} from "./repos.js";

export interface RepoUpdate {
  repo: string;
  url: string;
  newCommits: number;
  summary: string;
  relevantFiles: string[];
  actionSuggested: string;
}

export interface Discovery {
  url: string;
  name: string;
  stars: number;
  growthScore: number;
  language: string | null;
  why: string;
  category: string;
}

export interface KnowledgeUpdate {
  target: string;
  action: "ADD" | "UPDATE" | "REVIEW";
  content: string;
  source: string;
}

export interface RetireSuggestion {
  repo: string;
  replacedBy: string;
  reason: string;
}

export interface ScoutReport {
  scoutDate: string;
  reposChecked: number;
  reposWithUpdates: number;
  updates: RepoUpdate[];
  discoveries: Discovery[];
  knowledgeUpdates: KnowledgeUpdate[];
  retireSuggestions: RetireSuggestion[];
}

function isDueForCheck(repo: Repo): boolean {
  if (repo.status !== "active") return false;
  const lastChecked = new Date(repo.lastChecked).getTime();
  const now = Date.now();
  const hoursSinceCheck = (now - lastChecked) / (1000 * 60 * 60);

  switch (repo.checkFrequency) {
    case "daily":
      return hoursSinceCheck >= 20; // ~daily with buffer
    case "weekly":
      return hoursSinceCheck >= 144; // ~6 days
    case "monthly":
      return hoursSinceCheck >= 672; // ~28 days
    default:
      return hoursSinceCheck >= 20;
  }
}

function summarizeCommits(
  commits: Array<{ commit: { message: string } }>
): string {
  if (commits.length === 0) return "No new commits";
  const messages = commits
    .slice(0, 10)
    .map((c) => c.commit.message.split("\n")[0]);
  return messages.join("; ");
}

function categorizeFiles(files: Array<{ filename: string }>): string[] {
  // Surface files likely relevant to the flywheel (skills, instructions, configs)
  const relevant = files
    .map((f) => f.filename)
    .filter(
      (f) =>
        f.endsWith(".md") ||
        f.includes("skill") ||
        f.includes("instruction") ||
        f.includes("agent") ||
        f.includes("mcp") ||
        f.includes("config")
    );
  return relevant.slice(0, 10);
}

function suggestAction(
  repo: Repo,
  commits: Array<{ commit: { message: string } }>,
  files: Array<{ filename: string }>
): string {
  const fileNames = files.map((f) => f.filename).join(" ");
  const commitMsgs = commits
    .map((c) => c.commit.message.toLowerCase())
    .join(" ");

  if (fileNames.includes("SKILL.md") || fileNames.includes("skill"))
    return "Review new/updated skill patterns";
  if (fileNames.includes("instruction"))
    return "Check for instruction file format changes";
  if (commitMsgs.includes("breaking") || commitMsgs.includes("deprecat"))
    return "Check for breaking changes that affect your setup";
  if (files.length > 20) return "Large update — skim the changelog";
  return "Review changes for applicable patterns";
}

export async function checkSingleRepo(repo: Repo): Promise<RepoUpdate | null> {
  if (!repo.lastCommitSha) {
    // First check — just record current SHA
    const sha = await getLatestSha(repo.url);
    return {
      repo: repo.name,
      url: repo.url,
      newCommits: 0,
      summary: "Initial tracking — SHA recorded",
      relevantFiles: [],
      actionSuggested: "None — baseline recorded",
    };
  }

  try {
    const compare = await compareCommits(repo.url, repo.lastCommitSha);
    if (compare.ahead_by === 0) return null;

    return {
      repo: repo.name,
      url: repo.url,
      newCommits: compare.ahead_by,
      summary: summarizeCommits(compare.commits),
      relevantFiles: categorizeFiles(compare.files),
      actionSuggested: suggestAction(repo, compare.commits, compare.files),
    };
  } catch (err) {
    // Compare might fail if SHA is too old (force push, etc.)
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("404") || message.includes("No common ancestor")) {
      // SHA is stale — reset to current
      return {
        repo: repo.name,
        url: repo.url,
        newCommits: -1,
        summary: `SHA reset needed — compare failed: ${message.slice(0, 80)}`,
        relevantFiles: [],
        actionSuggested: "SHA out of sync — will reset on next run",
      };
    }
    throw err;
  }
}

const DEFAULT_SCOUT_QUERIES = [
  "copilot instructions",
  "MCP server",
  "claude agent skills",
  "AI coding agent",
];

export async function runScout(
  queries?: string[],
  growthThreshold: number = 50
): Promise<ScoutReport> {
  const data = await loadRepos();
  const active = getActiveRepos(data);
  const dueRepos = active.filter(isDueForCheck);

  const updates: RepoUpdate[] = [];
  let updatedData = data;

  // Check tracked repos for updates
  for (const repo of dueRepos) {
    try {
      const update = await checkSingleRepo(repo);
      if (update) {
        updates.push(update);
      }
      // Update lastChecked + SHA
      const latestSha = await getLatestSha(repo.url);
      updatedData = updateRepoAfterCheck(updatedData, repo.url, latestSha);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      updates.push({
        repo: repo.name,
        url: repo.url,
        newCommits: -1,
        summary: `Error checking: ${msg.slice(0, 100)}`,
        relevantFiles: [],
        actionSuggested: "Investigate error",
      });
    }
  }

  // Save updated check timestamps
  await saveRepos(updatedData);

  // Run discovery searches
  const searchQueries = queries ?? DEFAULT_SCOUT_QUERIES;
  const allDiscoveries: Discovery[] = [];

  for (const query of searchQueries) {
    try {
      const results = await searchRepos({
        query,
        sort: "growth-score",
        maxResults: 5,
        minStars: 50,
        minAgeDays: 7,
      });

      for (const r of results) {
        // Skip already-tracked repos
        if (data.repos.some((existing) => existing.url === r.url)) continue;
        if (r.growthScore < growthThreshold) continue;

        allDiscoveries.push({
          url: r.url,
          name: r.name,
          stars: r.stars,
          growthScore: r.growthScore,
          language: r.language,
          why: `Growth score ${r.growthScore}/day, ${r.stars} stars. ${r.description ?? ""}`.trim(),
          category: inferCategory(query),
        });
      }
    } catch {
      // Non-fatal — one search failing shouldn't tank the scout
    }
  }

  // Dedupe discoveries by URL
  const seenUrls = new Set<string>();
  const discoveries = allDiscoveries.filter((d) => {
    if (seenUrls.has(d.url)) return false;
    seenUrls.add(d.url);
    return true;
  });

  // Generate knowledge update suggestions from repo updates
  const knowledgeUpdates = generateKnowledgeHints(updates);

  // Suggest retirements if discoveries outclass existing tracked repos
  const retireSuggestions = suggestRetirements(active, discoveries);

  return {
    scoutDate: new Date().toISOString().split("T")[0],
    reposChecked: dueRepos.length,
    reposWithUpdates: updates.filter((u) => u.newCommits > 0).length,
    updates,
    discoveries: discoveries.slice(0, 10),
    knowledgeUpdates,
    retireSuggestions,
  };
}

function inferCategory(query: string): string {
  const q = query.toLowerCase();
  if (q.includes("skill") || q.includes("copilot") || q.includes("instruction"))
    return "skills";
  if (q.includes("mcp")) return "mcp";
  if (q.includes("agent") || q.includes("harness")) return "harness";
  return "reference";
}

function generateKnowledgeHints(updates: RepoUpdate[]): KnowledgeUpdate[] {
  const hints: KnowledgeUpdate[] = [];

  for (const update of updates) {
    if (update.newCommits <= 0) continue;

    for (const file of update.relevantFiles) {
      if (file.includes("SKILL.md") || file.includes("skill")) {
        hints.push({
          target: "skills/",
          action: "REVIEW",
          content: `New skill pattern in ${update.repo}: ${file}`,
          source: `${update.repo} — ${update.summary.slice(0, 60)}`,
        });
      }
      if (file.includes("instruction")) {
        hints.push({
          target: "instructions/",
          action: "REVIEW",
          content: `Instruction update in ${update.repo}: ${file}`,
          source: `${update.repo} — ${update.summary.slice(0, 60)}`,
        });
      }
    }
  }

  return hints.slice(0, 10);
}

function suggestRetirements(
  active: Repo[],
  discoveries: Discovery[]
): RetireSuggestion[] {
  const suggestions: RetireSuggestion[] = [];

  for (const discovery of discoveries) {
    for (const tracked of active) {
      if (discovery.category !== tracked.category) continue;
      // If a discovery has 10x+ growth score and same category, suggest retirement
      // We can't compute tracked growth score without extra API calls, so use a heuristic:
      // If discovery has >500 growth score and tracked repo hasn't been updated in 30+ days
      const daysSinceCheck =
        (Date.now() - new Date(tracked.lastChecked).getTime()) /
        (24 * 60 * 60 * 1000);
      if (discovery.growthScore > 500 && daysSinceCheck > 30) {
        suggestions.push({
          repo: tracked.name,
          replacedBy: discovery.name,
          reason: `${discovery.name} has growth score ${discovery.growthScore}/day vs ${tracked.name} inactive for ${Math.round(daysSinceCheck)}d. Same category: ${tracked.category}`,
        });
      }
    }
  }

  return suggestions.slice(0, 5);
}

export function formatScoutReport(report: ScoutReport): string {
  const lines: string[] = [];
  lines.push(`# Scout Report — ${report.scoutDate}\n`);
  lines.push(
    `Checked ${report.reposChecked} repos, ${report.reposWithUpdates} had updates.\n`
  );

  if (report.updates.length > 0) {
    lines.push("## Updates\n");
    for (const u of report.updates) {
      lines.push(`### ${u.repo} (+${u.newCommits} commits)`);
      lines.push(`${u.summary}`);
      if (u.relevantFiles.length > 0) {
        lines.push(`Files: ${u.relevantFiles.join(", ")}`);
      }
      lines.push(`Action: ${u.actionSuggested}\n`);
    }
  }

  if (report.discoveries.length > 0) {
    lines.push("## Discoveries\n");
    lines.push("| Repo | Stars | Growth | Language | Why |");
    lines.push("|------|-------|--------|----------|-----|");
    for (const d of report.discoveries) {
      lines.push(
        `| [${d.name}](${d.url}) | ${d.stars} | ${d.growthScore}/day | ${d.language ?? "—"} | ${d.why.slice(0, 80)} |`
      );
    }
    lines.push("");
  }

  if (report.knowledgeUpdates.length > 0) {
    lines.push("## Knowledge Hints\n");
    for (const k of report.knowledgeUpdates) {
      lines.push(`- **${k.action}** → \`${k.target}\`: ${k.content} (source: ${k.source})`);
    }
    lines.push("");
  }

  if (report.retireSuggestions.length > 0) {
    lines.push("## Retire Suggestions\n");
    for (const s of report.retireSuggestions) {
      lines.push(`- **${s.repo}** → replaced by ${s.replacedBy}: ${s.reason}`);
    }
  }

  return lines.join("\n");
}
