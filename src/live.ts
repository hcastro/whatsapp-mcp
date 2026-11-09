import { createConnection, createServer, type Socket } from "node:net";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { chatIdSchema } from "./config.js";

export const liveRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("read"),
      chatId: chatIdSchema,
      limit: z.number().int().min(1).max(100).default(50),
      cursor: z.string().min(1).max(1024).optional(),
      requestHistory: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("history"),
      chatId: chatIdSchema,
      direction: z.enum(["older", "recent"]),
      limit: z.number().int().min(1).max(100).default(100),
      cursor: z.string().min(1).max(1024).optional(),
    })
    .strict()
    .refine((request) => request.direction === "older" || !request.cursor, {
      message: "Recent recovery does not accept an older-page cursor",
    }),
  z
    .object({
      operation: z.literal("attachment"),
      messageId: z.string().regex(/^[a-f0-9]{64}$/),
      page: z.number().int().min(1).max(10000).default(1),
      sheet: z.string().max(200).optional(),
      startRow: z.number().int().min(1).max(1_000_000).default(1),
    })
    .strict(),
]);
export type LiveRequest = z.infer<typeof liveRequestSchema>;
export class LiveError extends Error {}
export function cancellable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new LiveError("Live request cancelled or exceeded its deadline."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export const LIVE_OPERATION_TIMEOUT_MS = 60_000;
export const LIVE_RESPONSE_TIMEOUT_MS = LIVE_OPERATION_TIMEOUT_MS + 5000;
export interface LiveContext {
  signal: AbortSignal;
}
const maxResponse = 16 * 1024 * 1024;

/** Local IPC exposes only bounded read operations; account credentials remain in sync. */
export async function listenLive(
  dataDir: string,
  handle: (request: LiveRequest, context: LiveContext) => Promise<object>,
) {
  const path = join(dataDir, "live.sock");
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket())
      throw new Error("Live socket path is not a socket");
    // The caller holds the exclusive sync lock, so this socket belongs to a stopped writer.
    unlinkSync(path);
  }
  const clients = new Set<Socket>();
  const jobs = new Set<Promise<void>>();
  const server = createServer((client) => {
    clients.add(client);
    client.once("close", () => clients.delete(client));
    client.on("error", () => client.destroy());
    client.setTimeout(5000, () => client.destroy());
    let buffer = "";
    let accepted = false;
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => {
      if (accepted) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 8192) {
        client.destroy();
        return;
      }
      if (!buffer.includes("\n")) return;
      accepted = true;
      client.setTimeout(0);
      const controller = new AbortController();
      const deadline = setTimeout(
        () => controller.abort(),
        LIVE_OPERATION_TIMEOUT_MS,
      );
      const cancel = () => controller.abort();
      client.once("close", cancel);
      const job = (async () => {
        try {
          const request = liveRequestSchema.parse(JSON.parse(buffer.trim()));
          const data = await handle(request, { signal: controller.signal });
          const response = JSON.stringify({ ok: true, data });
          if (Buffer.byteLength(response) > maxResponse)
            throw new LiveError(
              "Response too large; request fewer messages or a smaller attachment section.",
            );
          client.end(response + "\n");
        } catch (error) {
          client.end(
            JSON.stringify({
              ok: false,
              error:
                error instanceof LiveError
                  ? error.message
                  : "Live request failed. Check connection, selection, and request parameters.",
            }) + "\n",
          );
        }
      })();
      jobs.add(job);
      void job.finally(() => {
        clearTimeout(deadline);
        client.off("close", cancel);
        jobs.delete(job);
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  return async () => {
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled(jobs);
  };
}

export function requestLive(
  dataDir: string,
  request: LiveRequest,
): Promise<Record<string, unknown>> {
  const parsed = liveRequestSchema.parse(request);
  return new Promise((resolve, reject) => {
    const client = createConnection(join(dataDir, "live.sock"));
    let data = "";
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(new LiveError(message));
    };
    client.setEncoding("utf8");
    client.setTimeout(LIVE_RESPONSE_TIMEOUT_MS, () =>
      fail(
        "Live read timed out; WhatsApp or the phone may be unavailable. No cached result was substituted.",
      ),
    );
    client.on("error", () =>
      fail(
        "WhatsApp sync is unavailable. Start the linked sync process; cached messages are not a live result.",
      ),
    );
    client.on("connect", () => client.write(JSON.stringify(parsed) + "\n"));
    client.on("data", (chunk: string) => {
      data += chunk;
      if (Buffer.byteLength(data) > maxResponse) {
        fail("Live response exceeded its size limit.");
        return;
      }
      if (!data.includes("\n")) return;
      try {
        const value = JSON.parse(data.trim());
        if (!value.ok) {
          fail(
            typeof value.error === "string"
              ? value.error
              : "Live request failed.",
          );
          return;
        }
        if (!value.data || typeof value.data !== "object") throw new Error();
        settled = true;
        client.destroy();
        resolve(value.data);
      } catch {
        fail("Invalid response from local sync.");
      }
    });
    client.on("end", () => {
      if (!settled) fail("Sync ended before returning a live result.");
    });
  });
}
