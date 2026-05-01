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

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const files = await listMarkdownFiles(root, options);
  const results: BrainSearchResult[] = [];

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
    results.push({
      path: file.relativePath,
      title: extractTitle(content, file.absolutePath),
      score,
      snippet: makeSnippet(content, normalizedQuery, tokens),
    });
  }

  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_SEARCH_LIMIT, 50));
  return results
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit);
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
