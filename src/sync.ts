import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import makeWASocket, {
  DisconnectReason,
  jidNormalizedUser,
  type WAMessage,
  type WAVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { Archive, type IncomingMessage } from "./archive.js";
import { openAuth } from "./auth.js";
import { privateDirectory, type Policy } from "./config.js";
import { normalize } from "./normalize.js";
import { fetchMedia } from "./media.js";
import { resolveWebVersion } from "./wa-version.js";

export function retryDelay(attempt: number, reason?: number): number | null {
  if (
    [
      DisconnectReason.loggedOut,
      DisconnectReason.badSession,
      DisconnectReason.connectionReplaced,
      DisconnectReason.multideviceMismatch,
      DisconnectReason.forbidden,
    ].includes(reason ?? 0)
  )
    return null;
  return Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
}

/** Explicit network process; never called or imported by the MCP entry point. */
export async function sync(policy: Policy, allowLink: boolean): Promise<void> {
  const config = policy();
  if (allowLink && !process.stderr.isTTY)
    throw new Error("Linking requires an interactive terminal");
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("../scripts/patch-baileys.mjs", import.meta.url)),
      "--check",
    ],
    { stdio: "pipe" },
  );
  if (!allowLink && !existsSync(join(config.dataDir, "auth.sqlite")))
    throw new Error("No linked session; explicit account linking is required");
  privateDirectory(config.dataDir);
  const lockPath = join(config.dataDir, "sync.lock");
  const lock = openSync(lockPath, "wx", 0o600);
  let auth: ReturnType<typeof openAuth> | undefined;
  let archive: Archive | undefined;
  let socket: ReturnType<typeof makeWASocket> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let attempt = 0;
  let failure: Error | undefined;
  let socketClosing: Promise<void> | undefined;
  const abortWork = new AbortController();
  const mediaJobs: { raw: WAMessage; record: IncomingMessage }[] = [];
  let mediaWork: Promise<void> | undefined;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const closeSocket = () => {
    if (!socketClosing) {
      const current = socket;
      socketClosing = Promise.resolve()
        .then(() => current?.end(undefined))
        .catch(() => {
          if (!failure) {
            failure = new Error("Socket shutdown failed");
            try {
              archive?.setStatus("connection", {
                state: "error",
                at: Date.now(),
              });
            } catch {
              /* Preserve the shutdown error if storage is also unavailable. */
            }
          }
        });
    }
    return socketClosing;
  };
  const stop = (state = "stopped", error?: Error) => {
    if (stopped) return;
    stopped = true;
    failure = error;
    if (timer) clearTimeout(timer);
    abortWork.abort();
    mediaJobs.length = 0;
    try {
      archive?.setStatus("connection", { state, at: Date.now() });
    } catch {
      failure ??= new Error("Could not persist terminal sync status");
    }
    void closeSocket();
    finish();
  };
  const onSignal = () => stop();
  const fail = () => {
    process.stderr.write(
      "Sync failed; stopped to avoid silent gaps. Check configuration, account binding, credentials, and archive.\n",
    );
    stop(
      "error",
      new Error(
        "Sync failed; inspect configuration, account binding, credentials, and archive",
      ),
    );
  };
  const safely = (action: () => void) => {
    if (stopped) return;
    try {
      policy();
      action();
    } catch {
      fail();
    }
  };
  try {
    writeFileSync(lock, `${process.pid}\n`);
    auth = openAuth(join(config.dataDir, "auth.sqlite"), allowLink);
    archive = new Archive(join(config.dataDir, "archive.sqlite"), policy);
    const session = auth;
    const store = archive;
    const requireAccount = () => {
      const id = session.state.creds.me?.id;
      if (!id) throw new Error("Authenticated account identity unavailable");
      store.bindAccount(jidNormalizedUser(id));
    };
    if (session.state.creds.registered) requireAccount();
    // Optional downloads never hold up durable messages, revocations, or credentials.
    const drainMedia = async () => {
      while (!stopped && mediaJobs.length) {
        const job = mediaJobs.shift()!;
        const current = policy();
        if (
          !current.cacheMedia ||
          !current.allowedChats.includes(job.record.chatId)
        )
          continue;
        try {
          const bytes = await fetchMedia(
            job.raw,
            current.maxMediaBytes,
            abortWork.signal,
          );
          if (!stopped)
            store.cacheMedia(job.record.id, bytes, job.record.revision);
        } catch {
          if (!stopped) store.mediaFailure(job.record.id);
        }
      }
    };
    const startMedia = () => {
      if (!mediaWork && !stopped)
        mediaWork = drainMedia()
          .catch(fail)
          .finally(() => {
            mediaWork = undefined;
            if (mediaJobs.length && !stopped) startMedia();
          });
    };
    const queueMedia = (raw: WAMessage, record: IncomingMessage) => {
      if (mediaJobs.length >= 128) {
        store.mediaFailure(record.id);
        return;
      }
      mediaJobs.push({ raw, record });
      startMedia();
    };
    const ingest = (messages: WAMessage[], edit = false) => {
      requireAccount();
      for (const raw of messages) {
        const record = normalize(raw, edit);
        if (!record || !store.ingest(record)) continue;
        if (record.mediaType && policy().cacheMedia) queueMedia(raw, record);
      }
    };
    const pairingStages = {
      companionRefreshAt: null as number | null,
      pairSuccessAt: null as number | null,
    };
    if (allowLink) store.setStatus("pairingProtocol", pairingStages);
    const connect = () => {
      store.setStatus("connection", { state: "connecting", at: Date.now() });
      const current = makeWASocket({
        version,
        auth: session.state,
        logger: pino({ level: "silent" }),
        markOnlineOnConnect: false,
        syncFullHistory: true,
        emitOwnEvents: false,
        enableAutoSessionRecreation: false,
        enableRecentMessageCache: false,
        getMessage: async () => undefined,
      });
      socket = current;
      socketClosing = undefined;
      const accept = (action: () => void) => {
        if (current === socket) safely(action);
      };
      const content = (action: () => void) =>
        accept(() => {
          requireAccount();
          action();
        });
      if (allowLink) {
        for (const [event, stage] of [
          ["CB:notification,type:companion_reg_refresh", "companionRefreshAt"],
          ["CB:iq,,pair-success", "pairSuccessAt"],
        ] as const)
          current.ws.on(event, () =>
            accept(() => {
              pairingStages[stage] = Date.now();
              store.setStatus("pairingProtocol", pairingStages);
            }),
          );
      }
      current.ev.on("creds.update", () =>
        accept(() => {
          session.save();
          if (session.state.creds.me?.id) requireAccount();
        }),
      );
      current.ev.on("chats.upsert", (chats) =>
        content(() => store.discover(chats)),
      );
      current.ev.on("chats.update", (chats) =>
        content(() => store.discover(chats)),
      );
      current.ev.on("chats.delete", (ids) =>
        content(() => {
          for (const id of ids) store.clearChat(jidNormalizedUser(id));
        }),
      );
      current.ev.on("messages.upsert", (event) =>
        content(() => ingest(event.messages)),
      );
      current.ev.on("messaging-history.set", (event) =>
        content(() => {
          store.discover(event.chats);
          ingest(event.messages);
          store.setStatus("history", {
            at: Date.now(),
            progress: event.progress ?? null,
            isLatestChunk: event.isLatest ?? false,
            syncType: event.syncType ?? null,
            complete: false,
          });
        }),
      );
      current.ev.on("messaging-history.status", (event) =>
        content(() =>
          store.setStatus("history", {
            ...event,
            at: Date.now(),
            complete: false,
          }),
        ),
      );
      current.ev.on("messages.update", (updates) =>
        content(() => {
          for (const { key, update } of updates) {
            if (!key.remoteJid || !key.id) continue;
            if (update.message === null)
              store.deleteMessage(
                jidNormalizedUser(key.remoteJid),
                key.id,
                !!key.fromMe,
              );
            else if (update.message)
              ingest([{ ...update, key } as WAMessage], true);
          }
        }),
      );
      current.ev.on("messages.delete", (event) =>
        content(() => {
          if ("keys" in event) {
            for (const key of event.keys)
              if (key.remoteJid && key.id)
                store.deleteMessage(
                  jidNormalizedUser(key.remoteJid),
                  key.id,
                  !!key.fromMe,
                );
          } else store.clearChat(jidNormalizedUser(event.jid));
        }),
      );
      current.ev.on("connection.update", (event) =>
        accept(() => {
          if (event.qr) {
            if (!allowLink) {
              stop(
                "needs-relink",
                new Error("Session needs explicit relinking"),
              );
              return;
            }
            store.setStatus("linking", { stage: "qr-ready", at: Date.now() });
            // Remove superseded QR codes so a phone cannot scan an expired code from scrollback.
            process.stderr.write("\u001b[3J\u001b[2J\u001b[H");
            process.stderr.write(
              `Fresh QR generated at ${new Date().toLocaleTimeString()}. Scan with WhatsApp → Linked devices.\nQR codes rotate automatically; scan only the code currently displayed.\n`,
            );
            qrcode.generate(event.qr, { small: true }, (code) =>
              process.stderr.write(code + "\n"),
            );
          }
          if (event.isNewLogin)
            store.setStatus("linking", { stage: "paired", at: Date.now() });
          if (event.connection === "open") {
            requireAccount();
            attempt = 0;
            store.setStatus("linking", { stage: "linked", at: Date.now() });
            store.setStatus("connection", {
              state: "connected",
              at: Date.now(),
            });
            process.stderr.write(
              "Connected. Selected chats are being archived. Ctrl-C stops sync.\n",
            );
          }
          if (event.connection === "close") {
            const error = event.lastDisconnect?.error as
              | { output?: { statusCode?: number } }
              | undefined;
            const code = error?.output?.statusCode;
            store.setStatus("lastDisconnect", {
              code:
                typeof code === "number" && Number.isFinite(code) ? code : null,
              at: Date.now(),
            });
            if (allowLink)
              store.setStatus("linking", {
                stage: "disconnected",
                at: Date.now(),
              });
            const delay = retryDelay(attempt++, code);
            if (delay === null) {
              stop(
                "needs-relink",
                new Error(
                  "Session ended; inspect Linked devices before explicit relinking",
                ),
              );
            } else {
              store.setStatus("connection", {
                state: "reconnecting",
                at: Date.now(),
              });
              if (timer) clearTimeout(timer);
              timer = setTimeout(() => safely(connect), delay);
            }
          }
        }),
      );
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    heartbeat = setInterval(
      () => safely(() => store.setStatus("heartbeat", Date.now())),
      15_000,
    );
    store.setStatus("connection", {
      state: "resolving-version",
      at: Date.now(),
    });
    let version: WAVersion;
    try {
      version = await resolveWebVersion(abortWork.signal);
    } catch (error) {
      if (stopped) return;
      store.setStatus("connection", { state: "error", at: Date.now() });
      throw error;
    }
    if (stopped) return;
    store.setStatus("webVersion", {
      version,
      source: "web.whatsapp.com",
      at: Date.now(),
    });
    safely(connect);
    await done;
    await mediaWork;
  } finally {
    stopped = true;
    abortWork.abort();
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      await closeSocket();
      await mediaWork;
      auth?.save();
    } finally {
      auth?.close();
      archive?.close();
      closeSync(lock);
      unlinkSync(lockPath);
    }
  }
  if (failure) throw failure;
}
