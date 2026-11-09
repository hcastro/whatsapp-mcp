import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Archive, messageId } from "../dist/archive.js";
import { configPolicy } from "../dist/config.js";
import { connectedReader } from "../dist/connected.js";
import { listenLive } from "../dist/live.js";

test("real MCP and IPC preserve empty-page cursors and return delayed recovered records", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wa-history-wire-"));
  const config = join(dir, "config.json");
  const chatId = "111@s.whatsapp.net";
  writeFileSync(
    config,
    JSON.stringify({ dataDir: dir, allowedChats: [chatId] }),
  );
  const archive = new Archive(
    join(dir, "archive.sqlite"),
    configPolicy(config),
  );
  const message = (n) => ({
    id: messageId(chatId, String(n), false),
    chatId,
    sourceId: String(n),
    fromMe: false,
    senderId: null,
    timestamp: 100 + n,
    text: `synthetic ${n}`,
    deleted: false,
    edited: false,
    revision: 0,
    mediaType: null,
    mimeType: null,
  });
  for (let i = 1; i <= 4; i++) archive.ingest(message(i));
  let requests = 0;
  const socket = {
    query: async () => ({ attrs: { type: "result" } }),
    fetchMessageHistory: async (limit, key, timestamp) => {
      requests++;
      assert.equal(limit, 2);
      assert.equal(key.id, "1");
      assert.equal(timestamp, 101000);
      archive.ingest(message(0));
      archive.recordHistory([chatId]);
    },
    sendPeerDataOperationMessage: async () => {
      assert.fail("selected scope must not request account history");
    },
  };
  const read = connectedReader(
    archive,
    () => socket,
    new AbortController().signal,
  );
  const close = await listenLive(dir, read);
  const client = new Client(
    { name: "history-fixture", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(async () => {
    await client.close();
    await close();
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/cli.js"), "serve", "--config", config],
      stderr: "pipe",
    }),
  );
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined);
    assert.deepEqual(
      result.structuredContent,
      JSON.parse(result.content[0].text),
    );
    return result.structuredContent;
  };
  const page = await call("read_conversation", {
    chatId,
    limit: 4,
    requestHistory: false,
  });
  assert.equal(page.hasMoreLocal, false);
  const empty = await call("read_conversation", {
    chatId,
    limit: 2,
    cursor: page.nextCursor,
    requestHistory: false,
  });
  assert.equal(empty.messages.length, 0);
  assert.equal(empty.nextCursor, page.nextCursor);
  const recovered = await call("recover_history", {
    chatId,
    direction: "older",
    limit: 2,
    cursor: empty.nextCursor,
  });
  assert.deepEqual(
    recovered.messages.map((m) => m.sourceId),
    ["0"],
  );
  assert.equal(recovered.history.state, "history-observed");
  assert.equal(recovered.history.addedMessages, 1);
  assert.equal(recovered.history.pageChanged, true);
  assert.equal(recovered.coverage.complete, false);
  const invalid = await client.callTool({
    name: "recover_history",
    arguments: { chatId, direction: "recent", cursor: empty.nextCursor },
  });
  assert.equal(invalid.isError, true);
  assert.equal(requests, 1);
});
