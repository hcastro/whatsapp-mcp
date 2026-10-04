import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Archive } from "../dist/archive.js";
import { configPolicy } from "../dist/config.js";

test("legacy MCP 2024-11-05 client receives ordinary JSON text results over stdio", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wa-legacy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ dataDir: dir, allowedChats: [] }));
  new Archive(join(dir, "archive.sqlite"), configPolicy(config)).close();
  const child = spawn(
    process.execPath,
    [resolve("dist/cli.js"), "serve", "--config", config],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (waiter) {
      pending.delete(response.id);
      waiter(response);
    }
  });
  t.after(() => {
    lines.close();
    child.kill();
  });
  const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(
        () => reject(new Error("stdio response timeout")),
        5000,
      );
      pending.set(id, (response) => {
        clearTimeout(timeout);
        if (response.error) reject(new Error(JSON.stringify(response.error)));
        else resolve(response.result);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "legacy-offline-fixture", version: "1" },
  });
  assert.equal(initialized.protocolVersion, "2024-11-05");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const result = await request("tools/call", {
    name: "search_messages",
    arguments: { query: "absent" },
  });
  assert.equal(result.content[0].type, "text");
  assert.equal(JSON.parse(result.content[0].text).coverage.complete, false);
  assert.deepEqual(
    JSON.parse(result.content[0].text),
    result.structuredContent,
  );
  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
});
