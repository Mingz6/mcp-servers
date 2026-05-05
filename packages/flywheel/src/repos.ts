import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export interface Repo {
  url: string;
  name: string;
  category: string;
  why: string;
  status: "active" | "retired" | "archived";
  addedBy: "human" | "flywheel";
  addedAt: string;
  lastChecked: string;
  lastCommitSha: string;
  checkFrequency: "daily" | "weekly" | "monthly";
  retiredAt?: string;
  replacedBy?: string;
  retireReason?: string;
}

export interface ReposData {
  repos: Repo[];
}

const CONFIG_DIR = join(homedir(), ".config", "flywheel");
const REPOS_FILE = join(CONFIG_DIR, "repos.json");

async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
}

export async function loadRepos(): Promise<ReposData> {
  try {
    const raw = await readFile(REPOS_FILE, "utf-8");
    return JSON.parse(raw) as ReposData;
  } catch (err) {
    // First run: file doesn't exist yet — start with empty list.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { repos: [] };
    // Anything else (parse error, permission, IO) is a real problem.
    // Returning {repos:[]} here would cause the next saveRepos() to wipe the file.
    throw new Error(
      `Failed to read ${REPOS_FILE}: ${(err as Error).message}. ` +
        `Fix or move the file before adding/removing repos to avoid data loss.`
    );
  }
}

export async function saveRepos(data: ReposData): Promise<void> {
  await ensureConfigDir();
  await writeFile(REPOS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function getActiveRepos(data: ReposData): Repo[] {
  return data.repos.filter((r) => r.status === "active");
}

export function getRetiredRepos(data: ReposData): Repo[] {
  return data.repos.filter((r) => r.status === "retired");
}

export function findRepo(data: ReposData, nameOrUrl: string): Repo | undefined {
  return data.repos.find(
    (r) => r.name === nameOrUrl || r.url === nameOrUrl
  );
}

export function parseOwnerRepo(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

export function addRepo(
  data: ReposData,
  repo: Omit<Repo, "status" | "addedAt" | "lastChecked" | "lastCommitSha">
): ReposData {
  const existing = findRepo(data, repo.url);
  if (existing) throw new Error(`Repo already tracked: ${existing.name}`);

  const newRepo: Repo = {
    ...repo,
    status: "active",
    addedAt: new Date().toISOString(),
    lastChecked: new Date().toISOString(),
    lastCommitSha: "",
  };
  return { repos: [...data.repos, newRepo] };
}

export function removeRepo(data: ReposData, nameOrUrl: string): ReposData {
  const filtered = data.repos.filter(
    (r) => r.name !== nameOrUrl && r.url !== nameOrUrl
  );
  if (filtered.length === data.repos.length) {
    throw new Error(`Repo not found: ${nameOrUrl}`);
  }
  return { repos: filtered };
}

export function retireRepo(
  data: ReposData,
  nameOrUrl: string,
  replacedBy: string | undefined,
  reason: string
): ReposData {
  const repo = findRepo(data, nameOrUrl);
  if (!repo) throw new Error(`Repo not found: ${nameOrUrl}`);
  if (repo.status === "retired") throw new Error(`Repo already retired: ${repo.name}`);

  const updated: Repo = {
    ...repo,
    status: "retired",
    retiredAt: new Date().toISOString(),
    replacedBy,
    retireReason: reason,
  };

  return {
    repos: data.repos.map((r) => (r.url === repo.url ? updated : r)),
  };
}

export function updateRepoAfterCheck(
  data: ReposData,
  url: string,
  sha: string
): ReposData {
  return {
    repos: data.repos.map((r) =>
      r.url === url
        ? { ...r, lastChecked: new Date().toISOString(), lastCommitSha: sha }
        : r
    ),
  };
}

export function formatRepoList(data: ReposData): string {
  const active = getActiveRepos(data);
  const retired = getRetiredRepos(data);

  const lines: string[] = [];

  lines.push(`## Active Repos (${active.length})\n`);
  if (active.length === 0) {
    lines.push("No repos tracked yet.\n");
  } else {
    lines.push("| Name | Category | Frequency | Last Checked | Why |");
    lines.push("|------|----------|-----------|--------------|-----|");
    for (const r of active) {
      const checked = r.lastChecked
        ? new Date(r.lastChecked).toLocaleDateString()
        : "never";
      lines.push(
        `| [${r.name}](${r.url}) | ${r.category} | ${r.checkFrequency} | ${checked} | ${r.why.slice(0, 60)} |`
      );
    }
  }

  if (retired.length > 0) {
    lines.push(`\n## Retired (${retired.length})\n`);
    lines.push("| Name | Replaced By | Reason |");
    lines.push("|------|-------------|--------|");
    for (const r of retired) {
      lines.push(
        `| ${r.name} | ${r.replacedBy ?? "—"} | ${r.retireReason ?? "—"} |`
      );
    }
  }

  return lines.join("\n");
}
