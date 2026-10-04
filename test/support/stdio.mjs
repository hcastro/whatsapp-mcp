import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Archive } from "../../dist/archive.js";
import { configPolicy } from "../../dist/config.js";

export function stdioFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "wa-wire-"));
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ dataDir: dir, allowedChats: [] }));
  new Archive(join(dir, "archive.sqlite"), configPolicy(config)).close();
  const child = spawn(
    process.execPath,
    [resolve("dist/cli.js"), "serve", "--config", config],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
    lines.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`stdio response timeout: ${stderr}`));
      }, 5000);
      pending.set(id, (response) => {
        pending.delete(id);
        clearTimeout(timeout);
        resolve(response);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  return {
    child,
    exited,
    request,
    send,
    hasCredentials: () => existsSync(join(dir, "auth.sqlite")),
  };
}
