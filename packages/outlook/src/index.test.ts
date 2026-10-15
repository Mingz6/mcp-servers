import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "index.js");

async function connect(): Promise<Client> {
  const client = new Client({ name: "outlook-smoke", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  return client;
}

test("outlook_delete_draft is listed and needs at least one ID", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "outlook_delete_draft");
    assert.ok(tool, "outlook_delete_draft missing from tools/list");
    assert.deepEqual(tool.inputSchema.required, ["messageIds"]);

    const empty = await client.callTool({ name: "outlook_delete_draft", arguments: { messageIds: [] } });
    assert.equal(empty.isError, true);
  } finally {
    await client.close();
  }
});
