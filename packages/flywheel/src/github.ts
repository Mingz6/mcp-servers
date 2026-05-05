import { parseOwnerRepo } from "./repos.js";

const GITHUB_API = "https://api.github.com";

function getToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN environment variable not set");
  return token;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mcp-flywheel/1.0",
  };
}

async function githubFetch(path: string): Promise<unknown> {
  const url = `${GITHUB_API}${path}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export interface RepoInfo {
  default_branch: string;
  stargazers_count: number;
  created_at: string;
  pushed_at: string;
  description: string | null;
  language: string | null;
}

export async function getRepoInfo(repoUrl: string): Promise<RepoInfo> {
  const parsed = parseOwnerRepo(repoUrl);
  if (!parsed) throw new Error(`Invalid GitHub URL: ${repoUrl}`);
  const data = (await githubFetch(`/repos/${parsed.owner}/${parsed.repo}`)) as RepoInfo;
  return data;
}

export interface CompareResult {
  ahead_by: number;
  commits: Array<{
    sha: string;
    commit: { message: string; author: { date: string } };
  }>;
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
}

export async function compareCommits(
  repoUrl: string,
  baseSha: string,
  head?: string
): Promise<CompareResult> {
  const parsed = parseOwnerRepo(repoUrl);
  if (!parsed) throw new Error(`Invalid GitHub URL: ${repoUrl}`);

  const info = await getRepoInfo(repoUrl);
  const headRef = head ?? info.default_branch;

  const data = (await githubFetch(
    `/repos/${parsed.owner}/${parsed.repo}/compare/${baseSha}...${headRef}`
  )) as CompareResult;
  return data;
}

export async function getLatestSha(repoUrl: string): Promise<string> {
  const parsed = parseOwnerRepo(repoUrl);
  if (!parsed) throw new Error(`Invalid GitHub URL: ${repoUrl}`);

  const info = await getRepoInfo(repoUrl);
  const data = (await githubFetch(
    `/repos/${parsed.owner}/${parsed.repo}/commits/${info.default_branch}`
  )) as { sha: string };
  return data.sha;
}

export interface SearchResult {
  url: string;
  name: string;
  full_name: string;
  description: string | null;
  stars: number;
  language: string | null;
  created_at: string;
  pushed_at: string;
  growthScore: number;
  recentActivity: string;
}

export interface SearchOptions {
  query: string;
  language?: string;
  minStars?: number;
  minAgeDays?: number;
  sort?: "growth-score" | "stars" | "updated";
  maxResults?: number;
}

export async function searchRepos(opts: SearchOptions): Promise<SearchResult[]> {
  const minStars = opts.minStars ?? 50;
  const minAgeDays = opts.minAgeDays ?? 7;
  const maxResults = opts.maxResults ?? 10;

  let q = `${opts.query} stars:>=${minStars}`;
  if (opts.language) q += ` language:${opts.language}`;

  const sortParam = opts.sort === "updated" ? "updated" : "stars";
  const encoded = encodeURIComponent(q);
  const path = `/search/repositories?q=${encoded}&sort=${sortParam}&order=desc&per_page=30`;

  const data = (await githubFetch(path)) as {
    items: Array<{
      html_url: string;
      name: string;
      full_name: string;
      description: string | null;
      stargazers_count: number;
      language: string | null;
      created_at: string;
      pushed_at: string;
    }>;
  };

  const now = Date.now();
  const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;

  const results: SearchResult[] = data.items
    .filter((item) => {
      const age = now - new Date(item.created_at).getTime();
      return age >= minAgeMs;
    })
    .map((item) => {
      const ageDays = (now - new Date(item.created_at).getTime()) / (24 * 60 * 60 * 1000);
      const growthScore = ageDays > 0 ? item.stargazers_count / ageDays : 0;

      const daysSincePush = (now - new Date(item.pushed_at).getTime()) / (24 * 60 * 60 * 1000);
      let recentActivity: string;
      if (daysSincePush < 1) recentActivity = "active today";
      else if (daysSincePush < 7) recentActivity = `active ${Math.round(daysSincePush)}d ago`;
      else recentActivity = `last push ${Math.round(daysSincePush)}d ago`;

      return {
        url: item.html_url,
        name: item.name,
        full_name: item.full_name,
        description: item.description,
        stars: item.stargazers_count,
        language: item.language,
        created_at: item.created_at,
        pushed_at: item.pushed_at,
        growthScore: Math.round(growthScore * 10) / 10,
        recentActivity,
      };
    });

  if (opts.sort === "growth-score" || !opts.sort) {
    results.sort((a, b) => b.growthScore - a.growthScore);
  }

  return results.slice(0, maxResults);
}

export async function getRecentCommitCount(
  repoUrl: string,
  sinceDays: number = 7
): Promise<number> {
  const parsed = parseOwnerRepo(repoUrl);
  if (!parsed) throw new Error(`Invalid GitHub URL: ${repoUrl}`);

  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const data = (await githubFetch(
    `/repos/${parsed.owner}/${parsed.repo}/commits?since=${since}&per_page=1`
  )) as unknown[];

  // GitHub doesn't return total count easily — check headers or use length
  // For simplicity, fetch up to 100 and count
  const commits = (await githubFetch(
    `/repos/${parsed.owner}/${parsed.repo}/commits?since=${since}&per_page=100`
  )) as unknown[];

  return commits.length;
}
