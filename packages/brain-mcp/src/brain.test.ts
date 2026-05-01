import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    buildGraph,
    captureSource,
    createBrainPage,
    ensureMarkdownPath,
    findBacklinks,
    linkSourceCitations,
    lintBrain,
    packContext,
    readBrainPage,
    replaceBrainText,
    resolveBrainPath,
    searchBrain,
    validatePageLinks,
} from "./brain.js";

async function withBrain<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "brain-mcp-test-"));
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await mkdir(path.join(root, "notes"), { recursive: true });
    await mkdir(path.join(root, "_done"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "index.md"),
      "# Index\n\nSee [Topic](topic.md) and [[project]].\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "docs", "topic.md"),
      "# Topic\n\nAgent knowledge belongs in a durable Markdown wiki.\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "notes", "project.md"),
      "# Project\n\nThis links back to [[topic]].\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "_done", "old.md"),
      "# Old\n\nArchived agent knowledge.\n",
      "utf8"
    );

    return await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("resolveBrainPath keeps paths inside the brain root", async () => {
  await withBrain(async (root) => {
    const resolved = resolveBrainPath(root, "docs/topic.md");
    assert.equal(resolved, path.join(root, "docs", "topic.md"));
    assert.throws(() => resolveBrainPath(root, "../escape.md"), /escapes brain root/);
    assert.throws(() => ensureMarkdownPath(path.join(root, "docs", "topic.txt")), /Only Markdown/);
  });
});

test("searchBrain returns ranked Markdown snippets and skips archives by default", async () => {
  await withBrain(async (root) => {
    const results = await searchBrain(root, "agent knowledge", { limit: 10 });
    assert.equal(results[0]?.path, "docs/topic.md");
    assert.equal(results.some((result) => result.path === "_done/old.md"), false);

    const archivedResults = await searchBrain(root, "archived agent", { includeArchived: true });
    assert.equal(archivedResults[0]?.path, "_done/old.md");
  });
});

test("readBrainPage returns page content with title metadata", async () => {
  await withBrain(async (root) => {
    const page = await readBrainPage(root, "docs/topic.md");
    assert.equal(page.path, "docs/topic.md");
    assert.equal(page.title, "Topic");
    assert.match(page.content, /durable Markdown wiki/);
  });
});

test("findBacklinks resolves Markdown and wiki links", async () => {
  await withBrain(async (root) => {
    const backlinks = await findBacklinks(root, "docs/topic.md");
    assert.deepEqual(
      backlinks.map((backlink) => backlink.path).sort(),
      ["docs/index.md", "notes/project.md"]
    );
  });
});

test("buildGraph returns a local graph around one page", async () => {
  await withBrain(async (root) => {
    const graph = await buildGraph(root, { startPath: "docs/topic.md", depth: 1 });
    assert.ok(graph.nodes.some((node) => node.id === "docs/topic.md"));
    assert.ok(graph.nodes.some((node) => node.id === "docs/index.md"));
    assert.ok(graph.edges.some((edge) => edge.from === "docs/index.md" && edge.to === "docs/topic.md"));
  });
});

test("replaceBrainText requires exactly one match", async () => {
  await withBrain(async (root) => {
    await replaceBrainText(root, "docs/topic.md", "durable Markdown wiki", "curated Markdown graph");
    const updated = await readFile(path.join(root, "docs", "topic.md"), "utf8");
    assert.match(updated, /curated Markdown graph/);

    await writeFile(path.join(root, "docs", "dupe.md"), "# Dupe\n\nrepeat repeat\n", "utf8");
    await assert.rejects(
      () => replaceBrainText(root, "docs/dupe.md", "repeat", "once"),
      /exactly once; found 2/
    );
  });
});

test("createBrainPage and captureSource create Markdown inside the root", async () => {
  await withBrain(async (root) => {
    const created = await createBrainPage(root, "docs/new-page.md", "# New Page\n");
    assert.equal(created.path, "docs/new-page.md");

    const captured = await captureSource(root, {
      title: "Agent Brain Layer",
      source: "https://example.com/brain",
      summary: "A source about agent-readable knowledge.",
      tags: ["agent", "wiki"],
    });
    assert.match(captured.path, /^learning\/sources\/\d{4}-\d{2}-\d{2}-agent-brain-layer\.md$/);

    const content = await readFile(path.join(root, captured.path), "utf8");
    assert.match(content, /type: source/);
    assert.match(content, /A source about agent-readable knowledge/);
  });
});

test("lintBrain finds orphan pages, broken links, and missing titles", async () => {
  await withBrain(async (root) => {
    await writeFile(
      path.join(root, "docs", "orphan.md"),
      "# Orphan\n\nNobody links here.\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "docs", "broken.md"),
      "# Broken\n\nLinks to [missing](does-not-exist.md) and [[ghost-page]].\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "docs", "no-title.md"),
      "Some prose without a heading.\n\nLinks back to [Topic](topic.md).\n",
      "utf8"
    );
    // give orphan an inbound from broken so only no-title and broken stay flagged for orphan
    const report = await lintBrain(root);
    const kindsByPath = new Map<string, Set<string>>();
    for (const issue of report.issues) {
      const set = kindsByPath.get(issue.path) || new Set<string>();
      set.add(issue.kind);
      kindsByPath.set(issue.path, set);
    }
    assert.ok(kindsByPath.get("docs/orphan.md")?.has("orphan"));
    assert.ok(kindsByPath.get("docs/broken.md")?.has("broken-link"));
    assert.ok(kindsByPath.get("docs/no-title.md")?.has("missing-title"));
  });
});

test("lintBrain scopes to paths and kinds", async () => {
  await withBrain(async (root) => {
    await writeFile(
      path.join(root, "docs", "broken.md"),
      "# Broken\n\n[gone](nope.md)\n",
      "utf8"
    );
    const scoped = await lintBrain(root, {
      paths: ["docs/broken.md"],
      kinds: ["broken-link"],
    });
    assert.equal(scoped.scanned, 1);
    assert.ok(scoped.issues.every((issue) => issue.path === "docs/broken.md"));
    assert.ok(scoped.issues.every((issue) => issue.kind === "broken-link"));
  });
});

test("validatePageLinks reports unresolved internal links from candidate content", async () => {
  await withBrain(async (root) => {
    const broken = await validatePageLinks(root, "docs/topic.md", {
      content: "# Topic\n\n[bad](missing.md) and [[also-missing]] and [ok](index.md)\n",
    });
    const targets = broken.map((entry) => entry.rawTarget).sort();
    assert.deepEqual(targets, ["also-missing", "missing.md"]);
  });
});

test("linkSourceCitations adds wiki page to source frontmatter once", async () => {
  await withBrain(async (root) => {
    await mkdir(path.join(root, "learning", "sources"), { recursive: true });
    await writeFile(
      path.join(root, "learning", "sources", "2026-01-01-foo.md"),
      "---\ntype: source\nstatus: draft\n---\n\n# Foo\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "docs", "uses-foo.md"),
      "# Uses Foo\n\nSee [foo](../learning/sources/2026-01-01-foo.md).\n",
      "utf8"
    );

    const first = await linkSourceCitations(root, "docs/uses-foo.md");
    assert.deepEqual([...first.cited], ["learning/sources/2026-01-01-foo.md"]);
    assert.deepEqual([...first.updated], ["learning/sources/2026-01-01-foo.md"]);

    const sourceContent = await readFile(
      path.join(root, "learning", "sources", "2026-01-01-foo.md"),
      "utf8"
    );
    assert.match(sourceContent, /wiki_pages:\n\s+- docs\/uses-foo\.md/);

    const second = await linkSourceCitations(root, "docs/uses-foo.md");
    assert.equal(second.updated.length, 0);
  });
});

test("packContext walks the graph and respects the token budget", async () => {
  await withBrain(async (root) => {
    const pack = await packContext(root, {
      seedPaths: ["docs/topic.md"],
      budgetTokens: 800,
      maxHops: 2,
    });
    assert.ok(pack.pages.length > 0);
    assert.equal(pack.pages[0]?.path, "docs/topic.md");
    assert.equal(pack.pages[0]?.hops, 0);
    assert.ok(pack.usedTokens <= pack.budgetTokens);
    const paths = pack.pages.map((page) => page.path);
    assert.ok(paths.includes("docs/index.md"));
  });
});

test("packContext can seed from a query when seedPaths is omitted", async () => {
  await withBrain(async (root) => {
    const pack = await packContext(root, {
      query: "agent knowledge",
      budgetTokens: 1200,
      maxHops: 1,
    });
    assert.ok(pack.seed.includes("docs/topic.md"));
    assert.ok(pack.pages.some((page) => page.path === "docs/topic.md"));
  });
});

