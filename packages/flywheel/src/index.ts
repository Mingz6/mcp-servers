import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
    compareCommits,
    getLatestSha,
    searchRepos
} from "./github.js";
import {
    addRepo,
    findRepo,
    formatRepoList,
    loadRepos,
    removeRepo,
    retireRepo,
    saveRepos,
} from "./repos.js";
import { checkSingleRepo, formatScoutReport, runScout } from "./scout.js";

const server = new McpServer({
  name: "flywheel",
  version: "1.0.0",
});

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

// --- Tool 1: flywheel_list_repos ---

server.tool(
  "flywheel_list_repos",
  "List all tracked repos with status, category, last checked date, and check frequency. Shows active and retired sections.",
  {},
  async () => {
    try {
      const data = await loadRepos();
      const text = formatRepoList(data);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --- Tool 2: flywheel_check_updates ---

server.tool(
  "flywheel_check_updates",
  "Check one or all tracked repos for new commits since last check. Returns commit count and summary per repo.",
  {
    repo: z
      .string()
      .optional()
      .describe(
        "Name or URL of a specific repo to check. Omit to check all active repos."
      ),
  },
  async ({ repo }) => {
    try {
      const data = await loadRepos();

      if (repo) {
        const found = findRepo(data, repo);
        if (!found) return toolError(new Error(`Repo not found: ${repo}`));
        const update = await checkSingleRepo(found);
        if (!update) {
          return {
            content: [
              { type: "text" as const, text: `${found.name}: No new commits since last check.` },
            ],
          };
        }
        // Update SHA
        const sha = await getLatestSha(found.url);
        const updated = { ...data, repos: data.repos.map((r) => r.url === found.url ? { ...r, lastChecked: new Date().toISOString(), lastCommitSha: sha } : r) };
        await saveRepos(updated);
        return {
          content: [
            {
              type: "text" as const,
              text: `**${update.repo}** — ${update.newCommits} new commits\n\n${update.summary}\n\nRelevant files: ${update.relevantFiles.join(", ") || "none"}\nAction: ${update.actionSuggested}`,
            },
          ],
        };
      }

      // Check all active repos
      const active = data.repos.filter((r) => r.status === "active");
      const results: string[] = [];
      let updatedData = data;

      for (const r of active) {
        try {
          const update = await checkSingleRepo(r);
          const sha = await getLatestSha(r.url);
          updatedData = {
            repos: updatedData.repos.map((existing) =>
              existing.url === r.url
                ? { ...existing, lastChecked: new Date().toISOString(), lastCommitSha: sha }
                : existing
            ),
          };
          if (update && update.newCommits > 0) {
            results.push(`**${update.repo}** — +${update.newCommits} commits: ${update.summary.slice(0, 100)}`);
          } else {
            results.push(`${r.name}: up to date`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push(`${r.name}: error — ${msg.slice(0, 80)}`);
        }
      }

      await saveRepos(updatedData);
      return {
        content: [{ type: "text" as const, text: results.join("\n\n") }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --- Tool 3: flywheel_get_changes ---

server.tool(
  "flywheel_get_changes",
  "Get detailed diff/changelog for a specific tracked repo since last check. Returns file list with additions/deletions and commit messages.",
  {
    repo: z
      .string()
      .describe("Name or URL of the repo to get changes for"),
  },
  async ({ repo }) => {
    try {
      const data = await loadRepos();
      const found = findRepo(data, repo);
      if (!found) return toolError(new Error(`Repo not found: ${repo}`));
      if (!found.lastCommitSha) {
        return {
          content: [
            { type: "text" as const, text: `${found.name}: No baseline SHA — run check_updates first.` },
          ],
        };
      }

      const compare = await compareCommits(found.url, found.lastCommitSha);

      const lines: string[] = [];
      lines.push(`## ${found.name} — Changes since last check\n`);
      lines.push(`Commits: ${compare.ahead_by}\n`);

      lines.push("### Commits\n");
      for (const c of compare.commits.slice(0, 20)) {
        const msg = c.commit.message.split("\n")[0];
        lines.push(`- \`${c.sha.slice(0, 7)}\` ${msg}`);
      }

      lines.push("\n### Files Changed\n");
      lines.push("| File | Status | +/- |");
      lines.push("|------|--------|-----|");
      for (const f of compare.files.slice(0, 30)) {
        lines.push(`| ${f.filename} | ${f.status} | +${f.additions}/-${f.deletions} |`);
      }
      if (compare.files.length > 30) {
        lines.push(`\n... and ${compare.files.length - 30} more files`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --- Tool 4: flywheel_add_repo ---

server.tool(
  "flywheel_add_repo",
  "Add a new GitHub repo to the flywheel watchlist for tracking.",
  {
    url: z.string().url().describe("GitHub repo URL"),
    name: z.string().describe("Short name for the repo (e.g. 'anthropics-skills')"),
    category: z
      .string()
      .describe("Category: skills, harness, mcp, reference, library"),
    why: z.string().describe("Why this repo is worth tracking (1-2 sentences)"),
    checkFrequency: z
      .enum(["daily", "weekly", "monthly"])
      .default("weekly")
      .describe("How often to check for updates"),
    addedBy: z
      .enum(["human", "flywheel"])
      .default("human")
      .describe("Who added this repo"),
  },
  async ({ url, name, category, why, checkFrequency, addedBy }) => {
    try {
      const data = await loadRepos();

      // Get initial SHA from GitHub
      const sha = await getLatestSha(url);

      const updated = addRepo(data, {
        url,
        name,
        category,
        why,
        addedBy,
        checkFrequency,
      });

      // Set the initial SHA
      const finalData = {
        repos: updated.repos.map((r) =>
          r.url === url ? { ...r, lastCommitSha: sha } : r
        ),
      };

      await saveRepos(finalData);
      return {
        content: [
          {
            type: "text" as const,
            text: `Added **${name}** (${category}) — tracking ${checkFrequency}.\nBaseline SHA: ${sha.slice(0, 7)}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --- Tool 5: flywheel_remove_repo ---

server.tool(
  "flywheel_remove_repo",
  "Hard-delete a repo from the watchlist. Prefer flywheel_retire_repo to preserve history.",
  {
    repo: z.string().describe("Name or URL of the repo to remove"),
  },
  async ({ repo }) => {
    try {
      const data = await loadRepos();
      const updated = removeRepo(data, repo);
      await saveRepos(updated);
      return {
        content: [
          { type: "text" as const, text: `Removed **${repo}** from watchlist.` },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --- Tool 6: flywheel_retire_repo ---

server.tool(
  "flywheel_retire_repo",
  "Retire a repo — stop checking but keep history. Records replacement and reason.",
  {
    repo: z.string().describe("Name or URL of the repo to retire"),
    replacedBy: z
      .string()
      .optional()
      .describe("Name of the repo that supersedes this one"),
    reason: z.string().describe("Why this repo is being retired"),
  },
  async ({ repo, replacedBy, reason }) => {
    try {
      const data = await loadRepos();
      const updated = retireRepo(data, repo, replacedBy, reason);
      await saveRepos(updated);
      return {
        content: [
          {
            type: "text" as const,
            text: `Retired **${repo}**${replacedBy ? ` → replaced by ${replacedBy}` : ""}.\nReason: ${reason}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --- Tool 7: flywheel_scout ---

server.tool(
  "flywheel_scout",
  "Run a full scout cycle: check all tracked repos for updates, search for new high-growth repos, generate knowledge hints and retire suggestions. Returns a structured report.",
  {
    queries: z
      .array(z.string())
      .optional()
      .describe(
        "Custom search queries to use for discovery. Defaults to: copilot instructions, MCP server, claude agent skills, AI coding agent"
      ),
    growthThreshold: z
      .number()
      .default(50)
      .describe("Minimum growth score (stars/day) to surface a discovery"),
  },
  async ({ queries, growthThreshold }) => {
    try {
      const report = await runScout(queries, growthThreshold);
      const text = formatScoutReport(report);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --- Tool 8: flywheel_search ---

server.tool(
  "flywheel_search",
  "Search GitHub for repos ranked by growth score (stars/day). Great for discovering fast-growing projects in a domain.",
  {
    query: z.string().describe("GitHub search query (e.g. 'copilot instructions', 'MCP server')"),
    language: z
      .string()
      .optional()
      .describe("Filter by programming language"),
    minStars: z
      .number()
      .default(50)
      .describe("Minimum stars to consider (default: 50)"),
    minAgeDays: z
      .number()
      .default(7)
      .describe("Minimum repo age in days (default: 7)"),
    sort: z
      .enum(["growth-score", "stars", "updated"])
      .default("growth-score")
      .describe("Sort order: growth-score (default), stars, or updated"),
    maxResults: z
      .number()
      .default(10)
      .describe("Max results to return (default: 10)"),
  },
  async ({ query, language, minStars, minAgeDays, sort, maxResults }) => {
    try {
      const results = await searchRepos({
        query,
        language,
        minStars,
        minAgeDays,
        sort,
        maxResults,
      });

      if (results.length === 0) {
        return {
          content: [
            { type: "text" as const, text: `No repos found matching "${query}" with the given filters.` },
          ],
        };
      }

      const lines: string[] = [];
      lines.push(`## Search: "${query}" (sorted by ${sort})\n`);
      lines.push("| # | Repo | Stars | Growth | Language | Activity | Description |");
      lines.push("|---|------|-------|--------|----------|----------|-------------|");

      results.forEach((r, i) => {
        lines.push(
          `| ${i + 1} | [${r.full_name}](${r.url}) | ${r.stars.toLocaleString()} | ${r.growthScore}/day | ${r.language ?? "—"} | ${r.recentActivity} | ${(r.description ?? "").slice(0, 60)} |`
        );
      });

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --- Start Server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
