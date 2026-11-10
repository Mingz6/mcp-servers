#!/usr/bin/env node
// Starts brain-mcp against examples/sample-brain and calls two of its tools over stdio,
// the way VS Code or Claude Code would. Needs `npm run build` first; no accounts or API keys.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sampleBrain = path.join(repoRoot, "examples", "sample-brain");
const serverEntry = path.join(repoRoot, "packages", "brain-mcp", "dist", "index.js");
if (!existsSync(serverEntry)) {
  console.error(`brain-mcp isn't built yet (${path.relative(repoRoot, serverEntry)} is missing). Run npm run build first.`);
  process.exit(1);
}
// A throwaway HOME keeps the server's index DB and logs away from any real brain on this machine.
const scratchHome = mkdtempSync(path.join(tmpdir(), "mcp-demo-"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: {
    PATH: process.env.PATH ?? "",
    HOME: scratchHome,
    BRAIN_MCP_ROOT: sampleBrain,
    BRAIN_MCP_LOG_LEVEL: "error",
  },
  stderr: "pipe",
});
const client = new Client({ name: "mcp-servers-demo", version: "1.0.0" });
let serverStderr = "";
transport.stderr?.on("data", (chunk) => {
  serverStderr += chunk;
});

function textOf(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function callTool(name, args) {
  console.log(`\n> ${name} ${JSON.stringify(args)}`);
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} returned an error: ${textOf(result)}`);
  console.log(textOf(result));
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const firstNames = tools.slice(0, 4).map((tool) => tool.name).join(", ");
  console.log(`brain-mcp is up with ${tools.length} tools: ${firstNames}, ...`);
  await callTool("brain_search", { query: "retry", limit: 2 });
  await callTool("brain_backlinks", { path: "docs/retry-policy.md" });
} catch (err) {
  console.error(`Demo failed: ${err instanceof Error ? err.message : String(err)}`);
  if (serverStderr) console.error(`brain-mcp stderr:\n${serverStderr}`);
  process.exitCode = 1;
} finally {
  await client.close();
  rmSync(scratchHome, { recursive: true, force: true });
}
