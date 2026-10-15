import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Archive, messageId } from "../dist/archive.js";
import { configPolicy } from "../dist/config.js";
test("real SDK client and child stdio server: tools, structured/text parity, errors, dynamic policy", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wa-stdio-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json");
  const config = {
    dataDir: dir,
    allowedChats: ["111@s.whatsapp.net"],
    cacheMedia: false,
  };
  writeFileSync(path, JSON.stringify(config));
  const archive = new Archive(join(dir, "archive.sqlite"), configPolicy(path));
  const id = messageId(config.allowedChats[0], "synthetic", false);
  archive.ingest({
    id,
    chatId: config.allowedChats[0],
    sourceId: "synthetic",
    fromMe: false,
    senderId: null,
    timestamp: 100,
    text: "synthetic fixture",
    deleted: false,
    edited: false,
    revision: 0,
    mediaType: null,
    mimeType: null,
  });
  archive.close();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli.js"), "serve", "--config", path],
    stderr: "pipe",
  });
  const client = new Client(
    { name: "offline-verification", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(async () => {
    await client.close();
  });
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), "modern");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), [
    "conversation_context",
    "get_media",
    "list_chats",
    "list_selected_chats",
    "read_attachment",
    "read_conversation",
    "search_messages",
    "sync_coverage",
  ]);
  for (const tool of tools) {
    assert.ok(tool.outputSchema);
    assert.equal(tool.annotations.readOnlyHint, true);
  }
  for (const [name, args] of [
    ["search_messages", {}],
    ["conversation_context", { messageId: id }],
    ["get_media", { messageId: id }],
    ["list_selected_chats", {}],
    ["sync_coverage", {}],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined);
    assert.deepEqual(
      result.structuredContent,
      JSON.parse(result.content[0].text),
    );
  }
  const result = await client.callTool({
    name: "search_messages",
    arguments: { query: "fixture" },
  });
  assert.equal(result.structuredContent.messages.length, 1);
  config.allowedChats = [];
  writeFileSync(path, JSON.stringify(config));
  assert.equal(
    (await client.callTool({ name: "get_media", arguments: { messageId: id } }))
      .isError,
    true,
  );
  assert.equal(
    (
      await client.callTool({
        name: "conversation_context",
        arguments: { messageId: id },
      })
    ).isError,
    true,
  );
  assert.equal(
    (await client.callTool({ name: "search_messages", arguments: {} }))
      .structuredContent.messages.length,
    0,
  );
  assert.equal(existsSync(join(dir, "auth.sqlite")), false);
  await client.close();
});
test("linking refused without explicit flag; offline sync refused without credentials", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wa-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json");
  const run = (args) =>
    spawnSync(process.execPath, ["dist/cli.js", ...args, "--config", path], {
      encoding: "utf8",
      timeout: 10_000,
    });
  assert.equal(run(["init"]).status, 0);
  assert.equal(run(["link"]).status, 1);
  assert.equal(run(["sync"]).status, 1);
  assert.equal(run(["link", "--accept-unofficial-client"]).status, 1);
  assert.equal(existsSync(join(dir, ".local", "auth.sqlite")), false);
});
