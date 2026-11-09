import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import makeWASocket, { proto } from "@whiskeysockets/baileys";
import { Archive } from "./archive.js";
import { cancellable, LiveError } from "./live.js";

type Socket = ReturnType<typeof makeWASocket>;
interface RecoveryRequest {
  chatId: string;
  direction: "older" | "recent";
  limit: number;
  cursor?: string;
}
interface Recovery {
  request: RecoveryRequest;
  at: number;
  state: string;
  scope: "chat" | "account";
  generation: number;
  readableBefore: number;
  pageBefore: string;
  active: boolean;
  failed: boolean;
}
const CHAT_COOLDOWN_MS = 60_000;
const ACCOUNT_COOLDOWN_MS = 15 * 60_000;

/** Coordinates bounded recovery; a delivered history batch never establishes complete coverage. */
export class HistoryRecovery {
  private requests = new Map<string, Recovery>();
  constructor(private archive: Archive) {}

  private page(request: RecoveryRequest) {
    return this.archive.recent(request.chatId, request.limit, request.cursor);
  }
  private fingerprint(request: RecoveryRequest) {
    return JSON.stringify(
      this.page(request).messages.map((message) => message.id),
    );
  }
  private observe(entry: Recovery) {
    const historyObserved =
      this.archive.historyGeneration(entry.request.chatId) > entry.generation;
    if (historyObserved && !entry.failed) entry.state = "history-observed";
    const coverage = this.archive.coverage(entry.request.chatId);
    const addedMessages = Math.max(
      0,
      coverage.readableMessages - entry.readableBefore,
    );
    return {
      at: entry.at,
      direction: entry.request.direction,
      requestedLimit: entry.request.limit,
      state: entry.state,
      scope: entry.scope,
      historyObserved,
      addedMessages,
      pageChanged: this.fingerprint(entry.request) !== entry.pageBefore,
      retryAfterMs: entry.failed
        ? 0
        : Math.max(0, entry.at + CHAT_COOLDOWN_MS - Date.now()),
      accountRetryAfterMs:
        entry.scope === "account" || entry.state === "full-history-throttled"
          ? Math.max(
              0,
              this.archive.fullHistoryRequestAt() +
                ACCOUNT_COOLDOWN_MS -
                Date.now(),
            )
          : 0,
    };
  }
  latest(chatId: string) {
    const entry = [...this.requests.values()]
      .reverse()
      .find((entry) => entry.request.chatId === chatId);
    return entry ? this.observe(entry) : { state: "not-requested" };
  }
  async recover(
    request: RecoveryRequest,
    socket: Socket,
    signal: AbortSignal,
    ensure: () => void,
  ) {
    ensure();
    this.page(request);
    if (request.direction === "recent" && request.cursor)
      throw new LiveError(
        "Recent recovery does not accept an older-page cursor.",
      );
    const anchor =
      request.direction === "older"
        ? this.archive.historyAnchor(request.chatId, request.cursor)
        : undefined;
    const key = JSON.stringify([request.chatId, request.direction, anchor?.id]);
    const previous = this.requests.get(key);
    if (
      previous &&
      (previous.active ||
        (!previous.failed && Date.now() - previous.at < CHAT_COOLDOWN_MS))
    )
      return this.observe(previous);
    if (this.requests.size >= 256 && !previous) {
      const oldest = [...this.requests].find(([, entry]) => !entry.active);
      if (oldest) this.requests.delete(oldest[0]);
      else throw new LiveError("History recovery is busy; retry shortly.");
    }
    const entry: Recovery = {
      request: { ...request },
      at: Date.now(),
      state: "requested",
      scope: "chat",
      generation: this.archive.historyGeneration(request.chatId),
      readableBefore: this.archive.coverage(request.chatId).readableMessages,
      pageBefore: this.fingerprint(request),
      active: true,
      failed: false,
    };
    this.requests.delete(key);
    this.requests.set(key, entry);
    try {
      let refused = false;
      try {
        // Recent recovery omits the anchor rather than inventing a phone message ID.
        await cancellable(
          socket.fetchMessageHistory(
            request.limit,
            anchor
              ? {
                  remoteJid: request.chatId,
                  id: anchor.sourceId,
                  fromMe: anchor.fromMe,
                }
              : { remoteJid: request.chatId },
            anchor ? anchor.timestamp * 1000 : Date.now(),
          ),
          signal,
        );
      } catch (error) {
        ensure();
        if (anchor || !this.archive.hasAccountAccess()) throw error;
        refused = true;
      }
      ensure();
      if (!refused) {
        for (let i = 0; i < 20; i++) {
          const observed = this.observe(entry);
          if (
            observed.historyObserved &&
            (request.direction === "older" || observed.pageChanged)
          )
            break;
          await delay(250, undefined, { signal });
          ensure();
        }
      }
      const observed = this.observe(entry);
      if (
        !observed.historyObserved ||
        (request.direction === "recent" && !observed.pageChanged)
      ) {
        entry.state = "waiting-for-phone";
        if (!anchor && this.archive.hasAccountAccess()) {
          const last = this.archive.fullHistoryRequestAt();
          if (Date.now() - last >= ACCOUNT_COOLDOWN_MS) {
            ensure();
            this.archive.setStatus("fullHistoryRequestAt", Date.now());
            entry.scope = "account";
            entry.generation = this.archive.historyGeneration(request.chatId);
            await cancellable(
              socket.sendPeerDataOperationMessage({
                peerDataOperationRequestType:
                  proto.Message.PeerDataOperationRequestType
                    .FULL_HISTORY_SYNC_ON_DEMAND,
                fullHistorySyncOnDemandRequest: {
                  requestMetadata: { requestId: randomUUID() },
                },
              }),
              signal,
            );
            ensure();
            entry.state = "full-history-requested";
          } else {
            entry.state = "full-history-throttled";
          }
        }
      }
      ensure();
      return this.observe(entry);
    } catch (error) {
      entry.failed = true;
      entry.state = "failed";
      throw error;
    } finally {
      entry.active = false;
    }
  }
}
