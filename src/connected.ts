import makeWASocket, { proto } from "@whiskeysockets/baileys";
import { Archive } from "./archive.js";
import { fetchMedia } from "./media.js";
import { readAttachment } from "./attachments.js";
import {
  cancellable,
  LiveError,
  type LiveRequest,
  type LiveContext,
} from "./live.js";
import { HistoryRecovery } from "./history.js";

/** Verifies the current connection and rechecks authorization before returning conversation or attachment content. */
export function connectedReader(
  archive: Archive,
  assertConnected: () => ReturnType<typeof makeWASocket>,
  signal: AbortSignal,
) {
  const recovery = new HistoryRecovery(archive);
  let activeReads = 0;
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
      if (request.operation !== "attachment") archive.coverage(request.chatId);
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
      const ensure = () => {
        operationSignal.throwIfAborted();
        if (assertConnected() !== current)
          throw new LiveError(
            "Connection changed during history retrieval; retry.",
          );
        archive.coverage(request.chatId);
      };
      let history;
      if (request.operation === "history") {
        history = await recovery.recover(
          request,
          current,
          operationSignal,
          ensure,
        );
      } else if (
        request.requestHistory &&
        result.messages.length < request.limit
      ) {
        history = await recovery.recover(
          { ...request, direction: "older" },
          current,
          operationSignal,
          ensure,
        );
      }
      ensure();
      result = archive.recent(request.chatId, request.limit, request.cursor);
      return {
        ...result,
        freshness: { connected: true, checkedAt },
        history: history ?? recovery.latest(request.chatId),
        notice:
          "Live connection verified. Messages reflect events received by this linked device; missing history is not evidence of an empty conversation.",
      };
    } finally {
      activeReads--;
    }
  };
}
