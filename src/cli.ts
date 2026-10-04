#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { configPolicy, privateDirectory } from "./config.js";
import { Archive } from "./archive.js";
import { createServer } from "./server.js";

process.umask(0o077);
const [command = "help", ...args] = process.argv.slice(2);
const configIndex = args.indexOf("--config");
const configPath = resolve(
  configIndex >= 0 ? (args[configIndex + 1] ?? "") : "config.json",
);
async function main() {
  if (command === "help") {
    process.stdout.write(
      "Commands: init | serve | chats | sync | link --accept-unofficial-client\nAll commands accept --config /absolute/config.json\nLink creates persistent account credentials and requires prior user approval.\n",
    );
    return;
  }
  if (command === "init" && !existsSync(configPath))
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          dataDir: ".local",
          allowedChats: [],
          cacheMedia: false,
          maxMediaBytes: 4194304,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  const policy = configPolicy(configPath);
  const config = policy();
  const path = join(config.dataDir, "archive.sqlite");
  if (command === "init") {
    privateDirectory(config.dataDir);
    new Archive(path, policy).close();
    process.stdout.write(
      `Initialized offline archive. Edit ${configPath} to select exact chat IDs.\n`,
    );
    return;
  }
  if (command === "serve") {
    const handle = serveStdio(
      () => {
        // Discovery can discard an instance before a legacy connection opens its own archive.
        const archive = new Archive(path, policy, true);
        try {
          const server = createServer(archive);
          server.server.onclose = () => archive.close();
          return server;
        } catch (error) {
          archive.close();
          throw error;
        }
      },
      {
        legacy: "serve",
        onerror: () => process.stderr.write("MCP transport error.\n"),
      },
    );
    process.once("SIGTERM", () => void handle.close());
    process.once("SIGINT", () => void handle.close());
    return;
  }
  if (command === "chats") {
    const archive = new Archive(path, policy, true);
    try {
      process.stdout.write(
        JSON.stringify(archive.discoveredChats(), null, 2) + "\n",
      );
    } finally {
      archive.close();
    }
    return;
  }
  if (command === "sync" || command === "link") {
    if (command === "link" && !args.includes("--accept-unofficial-client"))
      throw new Error(
        "Link requires prior user approval and --accept-unofficial-client",
      );
    const { sync } = await import("./sync.js");
    await sync(policy, command === "link");
    return;
  }
  throw new Error("Unknown command; run help");
}
main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Operation failed"}\n`,
  );
  process.exitCode = 1;
});
