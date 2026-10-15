import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import makeWASocket, { proto } from "@whiskeysockets/baileys";
import { Archive } from "./archive.js";
import { fetchMedia } from "./media.js";
import { readAttachment } from "./attachments.js";
import { LiveError, type LiveRequest, type LiveContext } from "./live.js";

function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
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

/** Verifies the current connection and rechecks authorization before returning conversation or attachment content. */
export function connectedReader(
  archive: Archive,
  assertConnected: () => ReturnType<typeof makeWASocket>,
  signal: AbortSignal,
) {
  const historyRequests = new Map<
    string,
    { at: number; state: string; generation: number }
  >();
  let activeReads = 0;
  let lastFullRequest = 0;
  return async (
    request: LiveRequest,
    context: LiveContext = { signal },
  ): Promise<object> => {
    const operationSignal = AbortSignal.any([signal, context.signal]);
    operationSignal.throwIfAborted();
    if (activeReads >= 4)
      throw new LiveError("Live reader is busy; retry shortly.");
    activeReads++;
    try {
      const current = assertConnected();
      if (request.operation === "read") archive.coverage(request.chatId);
      else archive.attachmentSource(request.messageId);
      const pong = await cancellable(
        current.query(
          {
            tag: "iq",
            attrs: { to: "s.whatsapp.net", type: "get", xmlns: "w:p" },
            content: [{ tag: "ping", attrs: {} }],
          },
          5000,
        ),
        operationSignal,
      );
      if (assertConnected() !== current || pong?.attrs?.type !== "result")
        throw new LiveError("WhatsApp did not confirm the live connection.");
      operationSignal.throwIfAborted();
      const checkedAt = Date.now();
      if (request.operation === "attachment") {
        const source = archive.attachmentSource(request.messageId);
        const raw = proto.WebMessageInfo.decode(source.payload);
        let bytes: Buffer;
        try {
          bytes = await fetchMedia(
            { ...raw, key: raw.key! },
            25 * 1024 * 1024,
            operationSignal,
          );
        } catch {
          throw new LiveError(
            "Attachment download failed: it may be expired, unavailable, or larger than 25 MiB.",
          );
        }
        const view = await readAttachment(
          bytes,
          source.fileName,
          request,
          operationSignal,
        );
        assertConnected();
        const latest = archive.attachmentSource(request.messageId);
        if (
          latest.revision !== source.revision ||
          !Buffer.from(latest.payload).equals(Buffer.from(source.payload))
        )
          throw new LiveError("Attachment changed during retrieval; retry.");
        if (assertConnected() !== current)
          throw new LiveError(
            "Connection changed during attachment retrieval; retry.",
          );
        return {
          messageId: request.messageId,
          ...view,
          freshness: { connected: true, checkedAt },
        };
      }
      let result = archive.recent(
        request.chatId,
        request.limit,
        request.cursor,
      );
      if (request.requestHistory && result.messages.length < request.limit) {
        const previous = historyRequests.get(request.chatId);
        if (!previous || Date.now() - previous.at > 60_000) {
          const generation = archive.historyGeneration(request.chatId);
          const state = { at: Date.now(), state: "requested", generation };
          historyRequests.set(request.chatId, state);
          const oldest = archive.search({ chatId: request.chatId, limit: 1 })
            .messages[0];
          // Empty chats have no anchor; omit it rather than inventing a message identity.
          let refusedWithoutAnchor = false;
          try {
            await cancellable(
              current.fetchMessageHistory(
                100,
                oldest
                  ? {
                      remoteJid: request.chatId,
                      id: oldest.sourceId,
                      fromMe: oldest.fromMe,
                    }
                  : { remoteJid: request.chatId },
                oldest ? oldest.timestamp * 1000 : Date.now(),
              ),
              operationSignal,
            );
          } catch (error) {
            operationSignal.throwIfAborted();
            if (
              assertConnected() !== current ||
              oldest ||
              !archive.hasAccountAccess()
            )
              throw error;
            archive.coverage(request.chatId);
            refusedWithoutAnchor = true;
          }
          for (let i = 0; !refusedWithoutAnchor && i < 20; i++) {
            await delay(250, undefined, { signal: operationSignal });
            operationSignal.throwIfAborted();
            if (assertConnected() !== current)
              throw new LiveError(
                "Connection changed during history retrieval; retry.",
              );
            const next = archive.recent(
              request.chatId,
              request.limit,
              request.cursor,
            );
            if (archive.historyGeneration(request.chatId) > generation) {
              state.state = "history-observed";
              result = next;
              break;
            }
          }
          if (state.state === "requested") {
            state.state = "waiting-for-phone";
            if (
              !oldest &&
              archive.hasAccountAccess() &&
              Date.now() - lastFullRequest > 15 * 60_000
            ) {
              lastFullRequest = Date.now();
              await cancellable(
                current.sendPeerDataOperationMessage({
                  peerDataOperationRequestType:
                    proto.Message.PeerDataOperationRequestType
                      .FULL_HISTORY_SYNC_ON_DEMAND,
                  fullHistorySyncOnDemandRequest: {
                    requestMetadata: { requestId: randomUUID() },
                  },
                }),
                operationSignal,
              );
              state.state = "full-history-requested";
            }
          }
        }
      }
      if (assertConnected() !== current)
        throw new LiveError("Connection changed during live read; retry.");
      result = archive.recent(request.chatId, request.limit, request.cursor);
      const pending = historyRequests.get(request.chatId);
      if (
        pending &&
        archive.historyGeneration(request.chatId) > pending.generation
      )
        pending.state = "history-observed";
      return {
        ...result,
        freshness: { connected: true, checkedAt },
        history: historyRequests.get(request.chatId) ?? {
          state: "not-requested",
        },
        notice:
          "Live connection verified. Messages reflect events received by this linked device; missing history is not evidence of an empty conversation.",
      };
    } finally {
      activeReads--;
    }
  };
}
