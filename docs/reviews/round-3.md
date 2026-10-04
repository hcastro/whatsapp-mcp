# Independent review round 3

Reviewed 2026-10-04, after round-2 fixes and before round-3 fixes. This is the final of three sequential reviews. Review-only: no implementation edits, account linking, real credentials, or external network access. Applied `~/.codex/skills/strategic-code-design/SKILL.md` and its exact `references/review-rubric.md`, `principles.md`, and `red-flags.md`, plus `~/.codex/skills/pr-comments/SKILL.md` for actionable feedback.

## Intended behavior and changed contracts

Only deliberately selected archived chats are available through an offline read-only MCP, while the explicitly started sync process durably handles credentials/messages, suppresses application-side mutations and presence, and shuts down optional bounded downloads without compromising message persistence.

Reviewed all source modules, dependency guard, setup/design documentation, prior review fix appendices, synthetic tests, and consequential paths in pinned Baileys. Contracts include account-bound SQLite persistence, live configuration scope, shutdown/reconnect ownership, media cancellation, explicit account linking, and structured/text MCP outputs.

## Verdict

**Block.** The installed dependency still broadcasts presence during ordinary credential updates, and an actual mid-body media abort produces an unhandled stream error while leaving its consumer pending; shutdown also releases resources before asynchronous socket cleanup finishes.

## Correctness and safety

- **[Blocker] Automatic credential-update presence bypasses the current guard.**
  - Evidence: `scripts/patch-baileys.mjs:3-9` suppresses only the connection callback in `Socket/chats.js`. Pinned `node_modules/@whiskeysockets/baileys/lib/Socket/socket.js:843-854` separately calls `sendNode({tag:'presence',attrs:{name}})` whenever the existing push name differs from `update.me?.name`. Executing the exact installed listener in an isolated function with an EventEmitter and fake sendNode, then emitting `{accountSyncCounter:1}`, produced `[{"tag":"presence","attrs":{}}]` for existing name `Synthetic`. No socket was opened.
  - Risk: even a partial credential update can broadcast presence, violating the explicit no-presence contract despite `markOnlineOnConnect:false` and the existing guard. The initialization test inspects only the previously identified call site.
  - Fix: enforce the forbidden application-side stanza policy at one guarded pinned low-level send boundary, or explicitly suppress every demonstrated automatic call site. Preserve auth/key/sync acknowledgments. Test partial and changed-name credential updates and the existing connection path using installed source; fail closed if the protected sink changes on upgrade.

- **[Blocker] The real media pipeline does not propagate input errors or cancellation.**
  - Evidence: `src/media.ts:39-58` consumes and destroys the returned decrypted stream, but pinned `Utils/messages-media.js:520` returns `fetched.pipe(output,{end:true})`. Node pipe does not forward source errors to the destination or cancel the source when the destination closes. An offline stubbed fetch Response streamed synthetically encrypted bytes, then errored its ReadableStream on the supplied AbortSignal. The actual installed `downloadEncryptedContent` produced `{"unhandled":["synthetic abort"],"outcome":"consumer still pending"}`. This confirms the parent's independently identified source-inspection concern.
  - Risk: timeout, Ctrl-C, or a network-body failure can crash the sync process through an unhandled source error, leave optional media work hanging, and bypass orderly credential/archive/lock cleanup. Destroying output on the size limit does not reliably terminate the source transfer either. Forwarding HTTP options alone is insufficient.
  - Fix: use a linked pipeline that propagates upstream errors and destroys both streams on cancellation/size rejection, with a narrow fail-closed compatibility guard if retaining the pinned implementation. Test successful decryption, mid-body network error, mid-body abort, and consumer/size-limit cancellation through the actual dependency boundary. No live network is needed.

- **[High] Sync closes databases and releases its writer lock before socket shutdown completes.**
  - Evidence: `src/sync.ts:83` and `:327` invoke `socket.end(undefined)` without awaiting it; `:329-332` close the databases and release the lock. Pinned `Socket/socket.js:472-509` declares async end and awaits websocket close plus end handlers before destroying the emitter. An actual-entrypoint synthetic socket with a deliberately pending end promise yielded `{"syncResolved":true,"endCompleted":false,"endCalls":2}`. This reproduces the ordering violation, not live credential loss.
  - Risk: shutdown can return while socket work is still active, permit another writer, and close the credential store before dependent cleanup completes. Any rejected end promise also lacks an owned error path. Tests currently make end synchronous, masking this contract mismatch.
  - Fix: own one tracked shutdown promise; await socket and media completion before final credential persistence/database close/lock release, preserving the original terminal status/error. Ensure cleanup still releases local resources if shutdown fails. Add a delayed asynchronous end regression asserting sync remains pending and the lock/auth handle remain available until cleanup finishes.

## Design quality

- Round-1 fixes are intact: schema ownership is checked before DDL, discovered-chat tombstones bypass history watermarks, nested view-once content is excluded, and RequestInit redirect/abort policy reaches actual fetch.
- Round-2 fixes are intact: messages and credentials persist independently of stalled media; configuration pins the directory; archive account binding is immutable and checked before network construction for an existing account; reconnect errors retain terminal state; stale socket events are ignored.
- **[Medium] Read-only transport policy currently depends on enumerating incidental caller locations.** The missed credential listener illustrates change amplification: every additional automatic call site must be noticed independently. A single guarded send boundary owns the actual policy and reduces that dependency. Keep transport synchronization traffic explicitly distinct from forbidden application stanzas.
- Archive remains a useful deep module for scope, IDs, SQL, ordering, tombstones, and account ownership. MCP handlers expose retrieval behavior without paths or socket credentials. README accurately separates offline verification from pending account linking and best-effort old history.
- Optional media is bounded to 128 queued jobs and rechecks current allowlist before transfer; caching rechecks message revision/deletion/scope. The queue itself no longer serializes durable events. Its reliability still depends on fixing the actual stream lifecycle above.

## Tests and verification

- Executed `npm run check`: strict TypeScript check, ESLint, guarded build, and **29/29 tests passed**.
- Coverage includes a real official SDK client connected to child-process stdio, a legacy MCP 2024-11-05 raw handshake, structured/text parity, authorization revocation, cursors, edits/tombstones, schema rejection, config directory changes, account binding, stalled-media durable events, terminal disconnect, reconnect construction failure and stale socket exclusion.
- Ran `/tmp/whatsapp-round3-repro.mjs`: exact installed credential listener and actual installed media decryption stream with fake fetch; both reproduced the blocker findings. Synthetic bytes and no network/account access.
- Ran `/tmp/whatsapp-round3-end-repro.mjs` with Node module mocking: actual sync/config/auth/archive entrypoint, synthetic credential marker rows, asynchronous mock socket shutdown. Reproduced early completion; temporary SQLite/config directory removed.
- Existing lifecycle media mock proves queue independence but cannot establish actual stream abort behavior; add the boundary tests above rather than merely another wrapper-level mock.
- No live connection, QR, history completeness, real media retention, or account behavior is claimed. Live older-history comparison remains a separate user-approved validation step.

## Suggested next patch

Centralize the pinned stanza prohibition, fix media stream ownership/error propagation, and await tracked socket shutdown before closing persistence. Add focused offline regressions, update the dependency guard/README description, and rerun the complete check. Verify these changes as continuation of round 3; no fourth review is needed.

## Post-fix verification — continuation of round 3

**Final verdict: Approve for the documented offline implementation.** All three actionable round-3 findings are addressed, with regression evidence at the relevant installed dependency and production lifecycle boundaries. This supersedes the pre-fix Block verdict above; it does not claim live WhatsApp validation.

- Reviewed the updated guarded `Socket/socket.js` sendNode sink. It suppresses presence, chatstate, and read/read-self/played/played-self receipts centrally. The exact installed sink and exact installed credential listener execute together in `test/transport-policy.test.mjs`: ordinary partial credentials and changed-name updates emit no transport frames, credential assignment still occurs, and delivery/sync receipt and IQ traffic passes. The original connection-time presence suppression remains in place. This fixes the demonstrated alternate caller without spreading another caller-specific condition into sync.
- Reviewed the pinned stream import/pipe replacement. `pipeline(fetched,output,callback)` now owns both stream lifetimes. The actual `downloadEncryptedContent` and `fetchMedia` boundaries decrypt synthetic content successfully, reject a byte-limit overflow, reject an abort after headers, and cancel the upstream response when output is destroyed. Re-running the independent mid-body encrypted-data reproduction now reports `{"unhandled":[],"outcome":"rejected: synthetic abort"}`. The isolated old credential-listener-only reproduction still records its attempted frame by design because its fake sendNode omits the new transport guard; the new integrated installed-sink test verifies that attempt is suppressed before transport.
- Reviewed the single tracked `socketClosing` promise and final cleanup ordering in `src/sync.ts`. Socket close errors become owned failures, terminal state is preserved, media/socket shutdown is awaited, final credentials save before databases close, and the lock releases afterward. The actual-entrypoint delayed-end test confirms sync stays pending, the writer lock remains, the credential key handle remains usable during shutdown, end executes once, and final credentials survive after completion. Rejected shutdown still releases the lock and rejects sync.
- Independently executed `node --experimental-test-module-mocks --test test/media-transfer.test.mjs test/lifecycle.test.mjs test/transport-policy.test.mjs`: **11/11 passed**. The implementation owner separately reported the cumulative `npm run check` passing **35/35**; the final release evidence should record its last full rerun.
- No remaining actionable finding in the targeted round-3 fixes. The original offline/live distinction, unofficial-client limitation, selected-chat configuration requirement, and best-effort historical coverage remain applicable. No account access or persistent Codex configuration changes occurred during review.
