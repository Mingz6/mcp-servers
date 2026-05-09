import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const BRAIN_ROOT_ENV = "BRAIN_MCP_ROOT";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".venv",
  "__pycache__",
  "dist",
  "node_modules",
]);
const DEFAULT_ARCHIVE_DIRS = new Set(["_done", "archive", "archives"]);
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_GRAPH_MAX_NODES = 200;

export type BrainFile = Readonly<{
  absolutePath: string;
  relativePath: string;
}>;

export type BrainSearchResult = Readonly<{
  path: string;
  title: string;
  score: number;
  snippet: string;
  matchType: "keyword" | "semantic" | "both";
}>;

export type BrainLink = Readonly<{
  from: string;
  to: string | null;
  text: string;
  rawTarget: string;
  type: "markdown" | "wiki";
}>;

export type BrainBacklink = Readonly<{
  path: string;
  title: string;
  text: string;
  rawTarget: string;
}>;

export type BrainGraph = Readonly<{
  root: string;
  nodes: ReadonlyArray<Readonly<{ id: string; title: string; degree: number }>>;
  edges: ReadonlyArray<Readonly<{ from: string; to: string; text: string }>>;
}>;

type GraphEdge = { from: string; to: string; text: string };

export function getBrainRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env[BRAIN_ROOT_ENV] || path.join(os.homedir(), "code", "brain"));
}

export function toBrainRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

export function resolveBrainPath(root: string, inputPath: string): string {
  const trimmedPath = inputPath.trim();
  if (!trimmedPath) {
    throw new Error("Path is required");
  }

  const rootPath = path.resolve(root);
  const cleanedPath = trimmedPath.startsWith("brain/")
    ? trimmedPath.slice("brain/".length)
    : trimmedPath;
  const expandedPath = cleanedPath.startsWith("~/")
    ? path.join(os.homedir(), cleanedPath.slice(2))
    : cleanedPath;
  const absolutePath = path.resolve(
    path.isAbsolute(expandedPath) ? expandedPath : path.join(rootPath, expandedPath)
  );

  if (absolutePath !== rootPath && !absolutePath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`Path escapes brain root: ${inputPath}`);
  }

  return absolutePath;
}

export function ensureMarkdownPath(absolutePath: string): void {
  if (path.extname(absolutePath).toLowerCase() !== ".md") {
    throw new Error("Only Markdown files are supported");
  }
}

export async function listMarkdownFiles(
  root: string,
  options: Readonly<{ includeArchived?: boolean; roots?: ReadonlyArray<string> }> = {}
): Promise<BrainFile[]> {
  const rootPath = path.resolve(root);
  const rootFilters = (options.roots || []).map((rootFilter) => {
    const filterPath = resolveBrainPath(rootPath, rootFilter);
    return toBrainRelative(rootPath, filterPath);
  });
  const files: BrainFile[] = [];

  async function walk(directoryPath: string): Promise<void> {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      const relativePath = toBrainRelative(rootPath, entryPath);

      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name, options.includeArchived)) {
          continue;
        }
        await walk(entryPath);
        continue;
      }

      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") {
        continue;
      }

      if (rootFilters.length > 0 && !isUnderAnyRoot(relativePath, rootFilters)) {
        continue;
      }

      files.push({ absolutePath: entryPath, relativePath });
    }
  }

  await walk(rootPath);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function readBrainPage(
  root: string,
  inputPath: string,
  maxChars = 12000
): Promise<Readonly<{ path: string; title: string; content: string; truncated: boolean }>> {
  const absolutePath = resolveBrainPath(root, inputPath);
  ensureMarkdownPath(absolutePath);

  const content = await fs.readFile(absolutePath, "utf8");
  const truncated = content.length > maxChars;
  const visibleContent = truncated ? content.slice(0, maxChars) : content;

  return {
    path: toBrainRelative(path.resolve(root), absolutePath),
    title: extractTitle(content, absolutePath),
    content: visibleContent,
    truncated,
  };
}

export async function searchBrain(
  root: string,
  query: string,
  options: Readonly<{
    includeArchived?: boolean;
    limit?: number;
    roots?: ReadonlyArray<string>;
  }> = {}
): Promise<BrainSearchResult[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    throw new Error("Search query is required");
  }

  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_SEARCH_LIMIT, 50));

  // --- Keyword search (existing) ---
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const files = await listMarkdownFiles(root, options);
  const keywordResults: Array<{ path: string; title: string; score: number; snippet: string }> = [];

  for (const file of files) {
    const stat = await fs.stat(file.absolutePath);
    if (stat.size > DEFAULT_MAX_FILE_BYTES) {
      continue;
    }

    const content = await fs.readFile(file.absolutePath, "utf8");
    const haystack = `${file.relativePath}\n${content}`.toLowerCase();
    const hasExactMatch = haystack.includes(normalizedQuery);
    const hasAllTokens = tokens.every((token) => haystack.includes(token));

    if (!hasExactMatch && !hasAllTokens) {
      continue;
    }

    const score = calculateScore(haystack, normalizedQuery, tokens, file.relativePath);
    keywordResults.push({
      path: file.relativePath,
      title: extractTitle(content, file.absolutePath),
      score,
      snippet: makeSnippet(content, normalizedQuery, tokens),
    });
  }

  keywordResults.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  // --- Semantic search (when index available) ---
  const semanticResults = await searchSemantic(query, limit * 2);

  // --- Merge via RRF ---
  if (semanticResults.length === 0) {
    return keywordResults.slice(0, limit).map((r) => ({ ...r, matchType: "keyword" as const }));
  }

  return mergeRRF(keywordResults, semanticResults, limit);
}

async function searchSemantic(
  query: string,
  topK: number
): Promise<Array<{ path: string; chunkId: string; content: string; distance: number }>> {
  try {
    const { isIndexReady, searchIndex } = await import("./hybrid-bridge.js");
    if (!isIndexReady()) return [];
    return searchIndex(query, topK);
  } catch {
    return [];
  }
}

const RRF_K = 60;

function mergeRRF(
  keywordResults: Array<{ path: string; title: string; score: number; snippet: string }>,
  semanticResults: Array<{ path: string; chunkId: string; content: string; distance: number }>,
  limit: number
): BrainSearchResult[] {
  const merged = new Map<string, {
    path: string;
    title: string;
    snippet: string;
    rrfScore: number;
    matchType: "keyword" | "semantic" | "both";
  }>();

  for (let rank = 0; rank < keywordResults.length; rank++) {
    const r = keywordResults[rank];
    const rrfScore = 1 / (RRF_K + rank + 1);
    merged.set(r.path, {
      path: r.path,
      title: r.title,
      snippet: r.snippet,
      rrfScore,
      matchType: "keyword",
    });
  }

  // Deduplicate semantic results by file path (keep best distance)
  const bestSemantic = new Map<string, { path: string; content: string; distance: number }>();
  for (const r of semanticResults) {
    const existing = bestSemantic.get(r.path);
    if (!existing || r.distance < existing.distance) {
      bestSemantic.set(r.path, r);
    }
  }

  const semanticRanked = [...bestSemantic.values()].sort((a, b) => a.distance - b.distance);

  for (let rank = 0; rank < semanticRanked.length; rank++) {
    const r = semanticRanked[rank];
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = merged.get(r.path);

    if (existing) {
      existing.rrfScore += rrfScore;
      existing.matchType = "both";
    } else {
      const title = r.path.split("/").pop()?.replace(/\.md$/, "") ?? r.path;
      merged.set(r.path, {
        path: r.path,
        title,
        snippet: r.content.slice(0, 240),
        rrfScore,
        matchType: "semantic",
      });
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit)
    .map((r) => ({
      path: r.path,
      title: r.title,
      score: Math.round(r.rrfScore * 10000),
      snippet: r.snippet,
      matchType: r.matchType,
    }));
}

export async function findBacklinks(
  root: string,
  inputPath: string,
  options: Readonly<{ includeArchived?: boolean; limit?: number }> = {}
): Promise<BrainBacklink[]> {
  const rootPath = path.resolve(root);
  const targetPath = resolveBrainPath(rootPath, inputPath);
  ensureMarkdownPath(targetPath);
  const targetRelativePath = toBrainRelative(rootPath, targetPath);
  const files = await listMarkdownFiles(rootPath, options);
  const lookup = buildMarkdownLookup(files);
  const backlinks: BrainBacklink[] = [];

  for (const file of files) {
    if (file.relativePath === targetRelativePath) {
      continue;
    }

    const content = await fs.readFile(file.absolutePath, "utf8");
    const links = extractLinks(content, file.relativePath, lookup);
    const matchingLink = links.find((link) => link.to === targetRelativePath);

    if (!matchingLink) {
      continue;
    }

    backlinks.push({
      path: file.relativePath,
      title: extractTitle(content, file.absolutePath),
      text: matchingLink.text,
      rawTarget: matchingLink.rawTarget,
    });
  }

  const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
  return backlinks.slice(0, limit);
}

export async function buildGraph(
  root: string,
  options: Readonly<{
    depth?: number;
    includeArchived?: boolean;
    maxNodes?: number;
    startPath?: string;
  }> = {}
): Promise<BrainGraph> {
  const rootPath = path.resolve(root);
  const files = await listMarkdownFiles(rootPath, options);
  const lookup = buildMarkdownLookup(files);
  const titleByPath = new Map<string, string>();
  const edges: GraphEdge[] = [];

  for (const file of files) {
    const content = await fs.readFile(file.absolutePath, "utf8");
    titleByPath.set(file.relativePath, extractTitle(content, file.absolutePath));

    for (const link of extractLinks(content, file.relativePath, lookup)) {
      if (link.to) {
        edges.push({ from: file.relativePath, to: link.to, text: link.text });
      }
    }
  }

  const maxNodes = Math.max(1, Math.min(options.maxNodes ?? DEFAULT_GRAPH_MAX_NODES, 1000));
  const selectedPaths = options.startPath
    ? selectLocalGraph(rootPath, options.startPath, edges, options.depth ?? 1, maxNodes)
    : selectGlobalGraph(files.map((file) => file.relativePath), edges, maxNodes);
  const selectedEdges = edges.filter(
    (edge) => selectedPaths.has(edge.from) && selectedPaths.has(edge.to)
  );
  const degreeByPath = calculateDegrees(selectedEdges);
  const nodes = [...selectedPaths]
    .sort((left, right) => left.localeCompare(right))
    .map((id) => ({ id, title: titleByPath.get(id) || id, degree: degreeByPath.get(id) || 0 }));

  return { root: rootPath, nodes, edges: selectedEdges };
}

export async function createBrainPage(
  root: string,
  inputPath: string,
  content: string
): Promise<Readonly<{ path: string; bytes: number }>> {
  const rootPath = path.resolve(root);
  const absolutePath = resolveBrainPath(rootPath, inputPath);
  ensureMarkdownPath(absolutePath);

  if (await exists(absolutePath)) {
    throw new Error(`Page already exists: ${toBrainRelative(rootPath, absolutePath)}`);
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const normalizedContent = content.endsWith("\n") ? content : `${content}\n`;
  await fs.writeFile(absolutePath, normalizedContent, "utf8");

  return { path: toBrainRelative(rootPath, absolutePath), bytes: Buffer.byteLength(normalizedContent) };
}

export async function replaceBrainText(
  root: string,
  inputPath: string,
  oldText: string,
  newText: string
): Promise<Readonly<{ path: string; replacements: number }>> {
  if (!oldText) {
    throw new Error("oldText is required");
  }

  const rootPath = path.resolve(root);
  const absolutePath = resolveBrainPath(rootPath, inputPath);
  ensureMarkdownPath(absolutePath);
  const content = await fs.readFile(absolutePath, "utf8");
  const replacements = countOccurrences(content, oldText);

  if (replacements !== 1) {
    throw new Error(`Expected oldText to appear exactly once; found ${replacements}`);
  }

  await fs.writeFile(absolutePath, content.replace(oldText, newText), "utf8");
  return { path: toBrainRelative(rootPath, absolutePath), replacements };
}

export async function captureSource(
  root: string,
  input: Readonly<{
    source: string;
    summary: string;
    tags?: ReadonlyArray<string>;
    targetDir?: string;
    title: string;
  }>
): Promise<Readonly<{ path: string; bytes: number }>> {
  const targetDir = input.targetDir || "learning/sources";
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(input.title) || "source";
  const relativePath = await nextAvailablePath(root, `${targetDir}/${date}-${slug}.md`);
  const tags = input.tags?.map((tag) => tag.trim()).filter(Boolean) || [];
  const content = [
    "---",
    "type: source",
    "status: draft",
    `source: ${quoteYaml(input.source)}`,
    `captured: ${date}`,
    `tags: [${tags.map(quoteYaml).join(", ")}]`,
    "---",
    "",
    `# ${input.title.trim()}`,
    "",
    "## Summary",
    "",
    input.summary.trim(),
    "",
  ].join("\n");

  return createBrainPage(root, relativePath, content);
}

// ---------- LINT ----------

export type BrainLintIssueKind =
  | "orphan"
  | "broken-link"
  | "missing-title"
  | "missing-source-frontmatter";

export type BrainLintIssue = Readonly<{
  kind: BrainLintIssueKind;
  path: string;
  detail: string;
}>;

export type BrainLintReport = Readonly<{
  scanned: number;
  issues: ReadonlyArray<BrainLintIssue>;
}>;

const ORPHAN_EXEMPT_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)README\.md$/i,
  /(^|\/)_?index\.md$/i,
  /(^|\/)wiki-log\.md$/i,
  /(^|\/)docs\/learning-log\.md$/i,
  /^life-scan-log\//,
  /^copilot\/(memories|delegate|colleagues|flywheel-log|repo-templates|crna|advisors|hooks)\//,
  /^learning\/sources\//,
  /^learning\//,
  /^family\//,
  /^crna\//,
];

function isOrphanExempt(relativePath: string): boolean {
  return ORPHAN_EXEMPT_PATTERNS.some((pattern) => pattern.test(relativePath));
}

export async function lintBrain(
  root: string,
  options: Readonly<{
    includeArchived?: boolean;
    paths?: ReadonlyArray<string>;
    kinds?: ReadonlyArray<BrainLintIssueKind>;
  }> = {}
): Promise<BrainLintReport> {
  const rootPath = path.resolve(root);
  const allFiles = await listMarkdownFiles(rootPath, { includeArchived: options.includeArchived });
  const lookup = buildMarkdownLookup(allFiles);
  const inboundCount = new Map<string, number>();
  const issues: BrainLintIssue[] = [];
  const kindFilter = options.kinds && options.kinds.length ? new Set(options.kinds) : null;

  for (const file of allFiles) {
    const content = await fs.readFile(file.absolutePath, "utf8");
    for (const link of extractLinks(content, file.relativePath, lookup)) {
      if (link.to) {
        inboundCount.set(link.to, (inboundCount.get(link.to) || 0) + 1);
      }
    }
  }

  const filterSet = options.paths && options.paths.length
    ? new Set(
        options.paths.map((targetPath) =>
          toBrainRelative(rootPath, resolveBrainPath(rootPath, targetPath))
        )
      )
    : null;

  const targetFiles = filterSet
    ? allFiles.filter((file) => filterSet.has(file.relativePath))
    : allFiles;

  function pushIssue(issue: BrainLintIssue): void {
    if (!kindFilter || kindFilter.has(issue.kind)) {
      issues.push(issue);
    }
  }

  for (const file of targetFiles) {
    const content = await fs.readFile(file.absolutePath, "utf8");

    if (!/^#\s+\S/m.test(content)) {
      pushIssue({ kind: "missing-title", path: file.relativePath, detail: "No # heading found" });
    }

    for (const link of extractLinks(content, file.relativePath, lookup)) {
      if (
        link.to === null &&
        link.rawTarget &&
        !isExternalTarget(link.rawTarget) &&
        isMarkdownLikeTarget(link.rawTarget)
      ) {
        pushIssue({
          kind: "broken-link",
          path: file.relativePath,
          detail: `${link.type} link "${link.rawTarget}" does not resolve`,
        });
      }
    }

    const inbound = inboundCount.get(file.relativePath) || 0;
    if (inbound === 0 && !isOrphanExempt(file.relativePath)) {
      pushIssue({ kind: "orphan", path: file.relativePath, detail: "No inbound links" });
    }

    const frontmatter = parseSimpleFrontmatter(content);
    if (
      frontmatter &&
      frontmatter.type === "source" &&
      inbound > 0 &&
      !("wiki_pages" in frontmatter)
    ) {
      pushIssue({
        kind: "missing-source-frontmatter",
        path: file.relativePath,
        detail: `Cited by ${inbound} page(s) but no wiki_pages: list`,
      });
    }
  }

  return { scanned: targetFiles.length, issues };
}

// ---------- VALIDATE PAGE LINKS ----------

export type BrainBrokenLink = Readonly<{
  rawTarget: string;
  text: string;
  type: "markdown" | "wiki";
}>;

export async function validatePageLinks(
  root: string,
  inputPath: string,
  options: Readonly<{ content?: string; includeArchived?: boolean }> = {}
): Promise<ReadonlyArray<BrainBrokenLink>> {
  const rootPath = path.resolve(root);
  const absolutePath = resolveBrainPath(rootPath, inputPath);
  ensureMarkdownPath(absolutePath);
  const relativePath = toBrainRelative(rootPath, absolutePath);
  const pageContent = options.content ?? (await fs.readFile(absolutePath, "utf8"));
  const files = await listMarkdownFiles(rootPath, { includeArchived: options.includeArchived });
  const lookup = buildMarkdownLookup(files);
  const broken: BrainBrokenLink[] = [];

  for (const link of extractLinks(pageContent, relativePath, lookup)) {
    if (
      link.to === null &&
      link.rawTarget &&
      !isExternalTarget(link.rawTarget) &&
      isMarkdownLikeTarget(link.rawTarget)
    ) {
      broken.push({ rawTarget: link.rawTarget, text: link.text, type: link.type });
    }
  }

  return broken;
}

// ---------- LINK SOURCE (bidirectional backlinks) ----------

export async function linkSourceCitations(
  root: string,
  inputPath: string,
  options: Readonly<{
    sourceRoots?: ReadonlyArray<string>;
    includeArchived?: boolean;
  }> = {}
): Promise<Readonly<{ updated: ReadonlyArray<string>; cited: ReadonlyArray<string> }>> {
  const rootPath = path.resolve(root);
  const absolutePath = resolveBrainPath(rootPath, inputPath);
  ensureMarkdownPath(absolutePath);
  const relativePath = toBrainRelative(rootPath, absolutePath);
  const pageContent = await fs.readFile(absolutePath, "utf8");
  const files = await listMarkdownFiles(rootPath, { includeArchived: options.includeArchived });
  const lookup = buildMarkdownLookup(files);
  const sourceRoots = options.sourceRoots && options.sourceRoots.length
    ? options.sourceRoots
    : ["learning/sources/", "learning/", "docs/chat-summaries/"];

  const cited = new Set<string>();
  for (const link of extractLinks(pageContent, relativePath, lookup)) {
    if (link.to && sourceRoots.some((sourceRoot) => link.to!.startsWith(sourceRoot))) {
      cited.add(link.to);
    }
  }

  const updated: string[] = [];
  for (const sourceRelativePath of cited) {
    const sourceAbsolutePath = path.join(rootPath, sourceRelativePath);
    if (!(await exists(sourceAbsolutePath))) {
      continue;
    }
    const sourceContent = await fs.readFile(sourceAbsolutePath, "utf8");
    const updatedContent = upsertWikiPageInFrontmatter(sourceContent, relativePath);
    if (updatedContent !== sourceContent) {
      await fs.writeFile(sourceAbsolutePath, updatedContent, "utf8");
      updated.push(sourceRelativePath);
    }
  }

  return { updated, cited: [...cited] };
}

function upsertWikiPageInFrontmatter(content: string, wikiPagePath: string): string {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatterMatch) {
    return `---\nwiki_pages:\n  - ${wikiPagePath}\n---\n\n${content}`;
  }

  const frontmatterBody = frontmatterMatch[1] || "";
  const wikiPagesMatch = frontmatterBody.match(
    /^wiki_pages:[ \t]*(\[[^\]]*\])[ \t]*$|^wiki_pages:[ \t]*\n((?:[ \t]+-[ \t]+[^\n]+\n?)+)/m
  );

  if (!wikiPagesMatch) {
    const newFrontmatterBody = `${frontmatterBody.replace(/\n*$/, "")}\nwiki_pages:\n  - ${wikiPagePath}`;
    return content.replace(frontmatterMatch[0], `---\n${newFrontmatterBody}\n---\n`);
  }

  const inlineList = wikiPagesMatch[1];
  const blockList = wikiPagesMatch[2];

  if (inlineList) {
    if (inlineList.includes(wikiPagePath)) {
      return content;
    }
    const inner = inlineList.slice(1, -1).trim();
    const newInline = inner
      ? `[${inner}, ${quoteYaml(wikiPagePath)}]`
      : `[${quoteYaml(wikiPagePath)}]`;
    return content.replace(inlineList, newInline);
  }

  if (blockList && blockList.includes(wikiPagePath)) {
    return content;
  }

  const newBlock = `${(blockList || "").replace(/\n*$/, "")}\n  - ${wikiPagePath}\n`;
  return content.replace(blockList || "", newBlock);
}

function parseSimpleFrontmatter(content: string): Record<string, string> | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return null;
  }

  const result: Record<string, string> = {};
  for (const line of (frontmatterMatch[1] || "").split("\n")) {
    const fieldMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (fieldMatch && fieldMatch[1]) {
      result[fieldMatch[1]] = (fieldMatch[2] || "").trim();
    }
  }
  return result;
}

// ---------- CONTEXT PACK ----------

export type BrainContextPackPage = Readonly<{
  path: string;
  title: string;
  hops: number;
  estimatedTokens: number;
  content: string;
}>;

export type BrainContextPack = Readonly<{
  seed: ReadonlyArray<string>;
  budgetTokens: number;
  usedTokens: number;
  pages: ReadonlyArray<BrainContextPackPage>;
}>;

const CHARS_PER_TOKEN = 4;

export async function packContext(
  root: string,
  options: Readonly<{
    seedPaths?: ReadonlyArray<string>;
    query?: string;
    budgetTokens?: number;
    maxHops?: number;
    includeArchived?: boolean;
  }>
): Promise<BrainContextPack> {
  const rootPath = path.resolve(root);
  const budget = Math.max(500, Math.min(options.budgetTokens ?? 4000, 64000));
  const maxHops = Math.max(0, Math.min(options.maxHops ?? 2, 5));
  const seeds: string[] = [];

  if (options.seedPaths) {
    for (const seedPath of options.seedPaths) {
      const relative = toBrainRelative(rootPath, resolveBrainPath(rootPath, seedPath));
      if (!seeds.includes(relative)) {
        seeds.push(relative);
      }
    }
  }

  if (options.query) {
    const hits = await searchBrain(rootPath, options.query, {
      limit: 5,
      includeArchived: options.includeArchived,
    });
    for (const hit of hits) {
      if (!seeds.includes(hit.path)) {
        seeds.push(hit.path);
      }
    }
  }

  if (seeds.length === 0) {
    throw new Error("packContext requires seedPaths or query");
  }

  const files = await listMarkdownFiles(rootPath, { includeArchived: options.includeArchived });
  const lookup = buildMarkdownLookup(files);
  const adjacency = new Map<string, Set<string>>();

  for (const file of files) {
    const content = await fs.readFile(file.absolutePath, "utf8");
    for (const link of extractLinks(content, file.relativePath, lookup)) {
      if (link.to) {
        addNeighbor(adjacency, file.relativePath, link.to);
        addNeighbor(adjacency, link.to, file.relativePath);
      }
    }
  }

  const hopByPath = new Map<string, number>();
  const queue: Array<Readonly<{ path: string; hops: number }>> = [];
  for (const seed of seeds) {
    hopByPath.set(seed, 0);
    queue.push({ path: seed, hops: 0 });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.hops >= maxHops) {
      continue;
    }
    for (const neighbor of adjacency.get(current.path) || []) {
      if (hopByPath.has(neighbor)) {
        continue;
      }
      hopByPath.set(neighbor, current.hops + 1);
      queue.push({ path: neighbor, hops: current.hops + 1 });
    }
  }

  const ordered = [...hopByPath.entries()].sort((left, right) => {
    if (left[1] !== right[1]) {
      return left[1] - right[1];
    }
    const leftDegree = adjacency.get(left[0])?.size || 0;
    const rightDegree = adjacency.get(right[0])?.size || 0;
    if (leftDegree !== rightDegree) {
      return rightDegree - leftDegree;
    }
    return left[0].localeCompare(right[0]);
  });

  const pages: BrainContextPackPage[] = [];
  let used = 0;

  for (const [relativePath, hops] of ordered) {
    const remaining = budget - used;
    if (remaining <= 50) {
      break;
    }
    const absolutePath = resolveBrainPath(rootPath, relativePath);
    if (!(await exists(absolutePath))) {
      continue;
    }
    const fullContent = await fs.readFile(absolutePath, "utf8");
    const charBudget = remaining * CHARS_PER_TOKEN;
    const sliced = fullContent.length > charBudget ? fullContent.slice(0, charBudget) : fullContent;
    const tokens = Math.ceil(sliced.length / CHARS_PER_TOKEN);
    pages.push({
      path: relativePath,
      title: extractTitle(fullContent, absolutePath),
      hops,
      estimatedTokens: tokens,
      content: sliced,
    });
    used += tokens;
    if (used >= budget) {
      break;
    }
  }

  return { seed: seeds, budgetTokens: budget, usedTokens: used, pages };
}

export function extractLinks(
  content: string,
  fromRelativePath: string,
  lookup: ReadonlyMap<string, string | null>
): BrainLink[] {
  const links: BrainLink[] = [];
  const markdownLinkPattern = /\[([^\]]+)]\(([^)]+)\)/g;
  const wikiLinkPattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?]]/g;

  for (const match of content.matchAll(markdownLinkPattern)) {
    if (match.index !== undefined && content[match.index - 1] === "!") {
      continue;
    }

    const rawTarget = cleanRawTarget(match[2] || "");
    if (isExternalTarget(rawTarget)) {
      continue;
    }

    links.push({
      from: fromRelativePath,
      to: resolveLinkTarget(fromRelativePath, rawTarget, lookup),
      text: match[1] || rawTarget,
      rawTarget,
      type: "markdown",
    });
  }

  for (const match of content.matchAll(wikiLinkPattern)) {
    const rawTarget = (match[1] || "").trim();
    const text = (match[2] || rawTarget).trim();
    links.push({
      from: fromRelativePath,
      to: resolveWikiTarget(rawTarget, lookup),
      text,
      rawTarget,
      type: "wiki",
    });
  }

  return links;
}

function buildMarkdownLookup(files: ReadonlyArray<BrainFile>): Map<string, string | null> {
  const lookup = new Map<string, string | null>();

  for (const file of files) {
    const withoutExtension = file.relativePath.replace(/\.md$/i, "");
    addLookupKey(lookup, file.relativePath.toLowerCase(), file.relativePath);
    addLookupKey(lookup, withoutExtension.toLowerCase(), file.relativePath);
    addLookupKey(lookup, path.posix.basename(withoutExtension).toLowerCase(), file.relativePath);
  }

  return lookup;
}

function addLookupKey(lookup: Map<string, string | null>, key: string, value: string): void {
  const existingValue = lookup.get(key);
  if (existingValue === undefined) {
    lookup.set(key, value);
    return;
  }

  if (existingValue !== value) {
    lookup.set(key, null);
  }
}

function resolveLinkTarget(
  fromRelativePath: string,
  rawTarget: string,
  lookup: ReadonlyMap<string, string | null>
): string | null {
  if (!rawTarget || isExternalTarget(rawTarget)) {
    return null;
  }

  const targetWithoutAnchor = stripAnchor(decodeLinkTarget(rawTarget));
  if (!targetWithoutAnchor) {
    return fromRelativePath;
  }

  const targetPath = targetWithoutAnchor.startsWith("/")
    ? targetWithoutAnchor.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(fromRelativePath), targetWithoutAnchor));

  const candidates = path.posix.extname(targetPath)
    ? [targetPath]
    : [targetPath, `${targetPath}.md`, `${targetPath}/index.md`];

  for (const candidate of candidates) {
    const match = lookup.get(candidate.toLowerCase());
    if (match) {
      return match;
    }
  }

  return null;
}

function resolveWikiTarget(rawTarget: string, lookup: ReadonlyMap<string, string | null>): string | null {
  const cleanTarget = stripAnchor(decodeLinkTarget(rawTarget)).replace(/\.md$/i, "");
  const match = lookup.get(cleanTarget.toLowerCase())
    ?? lookup.get(path.posix.basename(cleanTarget).toLowerCase());
  return match || null;
}

function selectLocalGraph(
  root: string,
  inputPath: string,
  edges: ReadonlyArray<GraphEdge>,
  depth: number,
  maxNodes: number
): Set<string> {
  const start = toBrainRelative(root, resolveBrainPath(root, inputPath));
  const adjacency = new Map<string, Set<string>>();

  for (const edge of edges) {
    addNeighbor(adjacency, edge.from, edge.to);
    addNeighbor(adjacency, edge.to, edge.from);
  }

  const selected = new Set<string>([start]);
  const queue: Array<Readonly<{ path: string; depth: number }>> = [{ path: start, depth: 0 }];

  while (queue.length > 0 && selected.size < maxNodes) {
    const current = queue.shift();
    if (!current || current.depth >= Math.max(0, Math.min(depth, 5))) {
      continue;
    }

    for (const neighbor of adjacency.get(current.path) || []) {
      if (selected.has(neighbor)) {
        continue;
      }

      selected.add(neighbor);
      queue.push({ path: neighbor, depth: current.depth + 1 });

      if (selected.size >= maxNodes) {
        break;
      }
    }
  }

  return selected;
}

function selectGlobalGraph(
  paths: ReadonlyArray<string>,
  edges: ReadonlyArray<GraphEdge>,
  maxNodes: number
): Set<string> {
  const degreeByPath = calculateDegrees(edges);
  return new Set(
    [...paths]
      .sort((left: string, right: string) => (degreeByPath.get(right) || 0) - (degreeByPath.get(left) || 0) || left.localeCompare(right))
      .slice(0, maxNodes)
  );
}

function calculateDegrees(edges: ReadonlyArray<GraphEdge>): Map<string, number> {
  const degreeByPath = new Map<string, number>();
  for (const edge of edges) {
    degreeByPath.set(edge.from, (degreeByPath.get(edge.from) || 0) + 1);
    degreeByPath.set(edge.to, (degreeByPath.get(edge.to) || 0) + 1);
  }
  return degreeByPath;
}

function addNeighbor(adjacency: Map<string, Set<string>>, from: string, to: string): void {
  const neighbors = adjacency.get(from) || new Set<string>();
  neighbors.add(to);
  adjacency.set(from, neighbors);
}

function shouldSkipDirectory(name: string, includeArchived = false): boolean {
  if (DEFAULT_IGNORED_DIRS.has(name)) {
    return true;
  }
  return !includeArchived && DEFAULT_ARCHIVE_DIRS.has(name);
}

function isUnderAnyRoot(relativePath: string, rootFilters: ReadonlyArray<string>): boolean {
  return rootFilters.some((rootFilter) => {
    const normalizedFilter = rootFilter.replace(/\/$/, "");
    return relativePath === normalizedFilter || relativePath.startsWith(`${normalizedFilter}/`);
  });
}

function calculateScore(
  haystack: string,
  normalizedQuery: string,
  tokens: ReadonlyArray<string>,
  relativePath: string
): number {
  const exactScore = countOccurrences(haystack, normalizedQuery) * 20;
  const tokenScore = tokens.reduce((score, token) => score + countOccurrences(haystack, token), 0);
  const pathScore = relativePath.toLowerCase().includes(normalizedQuery) ? 50 : 0;
  return exactScore + tokenScore + pathScore;
}

function makeSnippet(content: string, normalizedQuery: string, tokens: ReadonlyArray<string>): string {
  const lowerContent = content.toLowerCase();
  const exactIndex = lowerContent.indexOf(normalizedQuery);
  const tokenIndex = tokens
    .map((token) => lowerContent.indexOf(token))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const matchIndex = exactIndex >= 0 ? exactIndex : tokenIndex ?? 0;
  const start = Math.max(0, matchIndex - 120);
  const end = Math.min(content.length, matchIndex + 240);
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}

function countOccurrences(content: string, searchText: string): number {
  if (!searchText) {
    return 0;
  }

  let count = 0;
  let index = content.indexOf(searchText);
  while (index >= 0) {
    count += 1;
    index = content.indexOf(searchText, index + searchText.length);
  }
  return count;
}

function extractTitle(content: string, absolutePath: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.basename(absolutePath, path.extname(absolutePath));
}

function cleanRawTarget(rawTarget: string): string {
  const trimmedTarget = rawTarget.trim();
  const titleMatch = trimmedTarget.match(/^<?([^>\s]+)>?(?:\s+["'][^"']+["'])?$/);
  return titleMatch?.[1] || trimmedTarget;
}

function isExternalTarget(rawTarget: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(rawTarget);
}

function isMarkdownLikeTarget(rawTarget: string): boolean {
  const stripped = stripAnchor(decodeLinkTarget(rawTarget));
  if (!stripped || stripped.endsWith("/")) {
    return false;
  }
  const extension = path.posix.extname(stripped).toLowerCase();
  return extension === "" || extension === ".md";
}

function stripAnchor(rawTarget: string): string {
  return rawTarget.split("#", 1)[0] || "";
}

function decodeLinkTarget(rawTarget: string): string {
  try {
    return decodeURIComponent(rawTarget).replace(/\\/g, "/");
  } catch {
    return rawTarget.replace(/\\/g, "/");
  }
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

async function nextAvailablePath(root: string, relativePath: string): Promise<string> {
  const extension = path.posix.extname(relativePath);
  const basePath = relativePath.slice(0, -extension.length);
  let candidate = relativePath;
  let index = 2;

  while (await exists(resolveBrainPath(root, candidate))) {
    candidate = `${basePath}-${index}${extension}`;
    index += 1;
  }

  return candidate;
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}
