# Independent review round 2

Reviewed 2026-10-04 after round-1 fixes, before round-2 fixes. Applied the exact personal `~/.codex/skills/strategic-code-design/SKILL.md`, `references/review-rubric.md`, `principles.md`, and `red-flags.md`, plus `~/.codex/skills/pr-comments/SKILL.md`. No applicable AGENTS.md in project ancestry. Review-only: implementation was not changed; all reproduction used synthetic local data and a mocked socket/auth module, without network, linking, real credentials, or persistent configuration changes.

## Intended behavior and changed contracts

Only explicitly selected conversations from the intended WhatsApp account should be exposed through the offline archive; accepted sync events and credential updates should survive ordinary shutdown, and sync failures should remain visible in coverage.

Contracts reviewed: socket connection/reconnect/shutdown, credential durability, archive/account ownership, dynamic configuration, media queue ordering, round-1 archive/media fixes, and actual MCP stdio compatibility.

## Verdict

**Block.** A synthetic terminal disconnect reproduces loss of accepted messages and credential saves, and archive ownership is not bound to the linked account or a fixed data-directory configuration.

## Correctness and safety

- **[Blocker] Shutdown discards accepted content and credential updates.**
  - Evidence: `src/sync.ts:69-79` sets `stopped=true` and each queued task then skips execution. Credential saves share this queue (`130-134`); message/history ingestion awaits media downloads (`97-114`, `149-161`). A test-module-mocked socket emitted one selected message, one `creds.update`, then a terminal `connection.update` with reason 401. After `sync` returned, a read-only Archive query found **0** matching messages and the mocked credential store recorded **0 saves**. No actual socket or credentials were created.
  - Risk: Ctrl-C, logout, or a terminal disconnect can discard messages already received/acknowledged and leave credentials stale. A slow attachment widens this loss window to all following messages and auth updates. This is demonstrated event-ordering loss, not merely a speculative race.
  - Fix: durably handle accepted message metadata, tombstones, and credential updates independently of asynchronous media work. With synchronous SQLite, perform those writes in guarded event callbacks; use a separate bounded/cancellable media worker. Stop accepting new events while preserving already accepted durable work and safe handle closure. Test stop during media, immediate terminal close after events, and stale-socket events after reconnect.

- **[High] A running archive adopts selection from a different configured data directory.**
  - Evidence: `src/config.ts:25-30` rereads and returns a new `dataDir` on every operation; `cli.ts` and `sync.ts` open database handles once. Synthetic reproduction: open the first archive, persist a selected message, rewrite only config `dataDir` to a different directory, then call `search` through the same policy. It still returns **"old archive content"** instead of refusing the mismatched configuration.
  - Risk: a user moving config to a different archive/account can receive old archive content under the new selection. Sync also keeps writing its original directory while the config claims a different destination.
  - Fix: pin the resolved data directory for a process and fail closed if it changes, with a clear restart instruction. Continue allowing live chat/media policy changes. Add a real config-file rewrite regression.

- **[High] The archive has no authenticated-account ownership binding.**
  - Evidence: `src/sync.ts:93-96` opens auth and archive independently; neither connection-open nor ingestion checks `session.state.creds.me.id` against an archive owner. The archive schema and stable message ID include chat/source/direction but no account owner. This finding is established by source inspection; no real account switch was performed.
  - Risk: replacing/relinking credentials for another account in the same data directory can combine both accounts' history and expose the prior account's messages to the new session's allowlist. Shared contacts/group IDs make chat IDs insufficient to identify archive ownership.
  - Fix: store an immutable account binding derived from the authenticated normalized own-account identity; verify it before discovery/content ingestion and reject mismatches with a new-directory instruction. Fail safely for populated unbound archives. Test same account/device variants accepted, different account rejected without writes, and first-link binding before ingestion.

- **[High] Terminal failures are overwritten with an ordinary stopped status.**
  - Evidence: error handling writes `state: "error"` (`81-85`) and terminal disconnect writes `state: "needs-relink"` (`227-230`), but the successful return path unconditionally stores `state: "stopped"` (`252`). The terminal-disconnect reproduction above returned coverage `{state:"stopped"}` after reason 401, and `sync` resolved normally.
  - Risk: Codex/users cannot distinguish an orderly stop from a broken session using coverage; command supervisors can see a successful exit after an ingest failure. This undermines the explicit no-silent-gaps contract.
  - Fix: preserve the terminal reason and propagate operational failures where appropriate. Guard timer/reconnect callbacks too: the current delayed `setTimeout(connect, delay)` bypasses the startup try/catch if socket construction later throws. Test terminal status/exit behavior and reconnect factory failure.

## Design quality

- **[Medium] A single Promise queue conflates durable event acceptance with optional media transfer.** The lifecycle must remember whether a task is accepted, pending, downloading, or skipped, and auth persistence inherits attachment latency. Move the durable acceptance boundary into sync and isolate media scheduling behind a small bounded worker. Avoid adding scattered stop exceptions to each existing callback.
- Keep archive account ownership inside Archive and fixed-path validation inside configPolicy. Those decisions should not become repeated checks in every MCP handler.
- Round-1 fixes are present: deletion bypasses content watermarks, schema/ownership validation precedes DDL, actual HTTP fetch receives redirect/abort options through a guarded dependency patch, and nested view-once envelopes are rejected.

## Tests and verification

- Executed `node --test test/*.test.mjs` against the reviewed build: **21/21 passed**, including current official SDK client and legacy 2024-11-05 raw stdio tests.
- All four consequential round-1 regression areas passed: discovered/post-clear deletions, unsupported/unrelated schemas unchanged, nested view-once exclusion, and actual Baileys fetch-option forwarding.
- Executed a temporary Node `--experimental-test-module-mocks` reproduction against the actual `dist/sync.js` entrypoint. Replaced only socket/auth dependencies; actual Archive/config/sync lifecycle ran. Output: `accepted message persisted: 0 credential saves: 0 terminal status: { state: 'stopped', ... }`.
- Executed actual configPolicy/Archive rewrite fixture. Output: `config dataDir changed but old archive still returned: [ 'old archive content' ]`.
- Temporary fixture databases/config were removed. The reproducer itself is `/tmp/whatsapp-round2-repro.mjs` and contains only synthetic data. No live older-history or account behavior is claimed.
- Existing tests cover retry-delay arithmetic but not socket lifecycle. Use Node module mocks to exercise the production sync entrypoint rather than exposing a model-facing safety override or broad dependency-injection API.

## Suggested next patch

Separate synchronous durable event handling from optional cancellable media work, preserve terminal state/errors, pin process storage identity, and bind the archive to the authenticated account. Add focused offline lifecycle/config/account regressions and run the full check before the independent third review.

## Fixes applied after review

- Durable messages, tombstones, discovery and credential updates now execute synchronously in guarded event callbacks. Optional media uses a separate queue (128 pending maximum), checks current policy and aborts on stop. Late old-socket events are ignored.
- Data-directory identity is pinned by configPolicy; changing it fails closed until restart. Live selection and media settings still refresh per operation.
- Archive owns immutable account binding based on a hash of normalized authenticated own-account JID. Sync verifies before data writes and before opening a socket for an existing session. Different accounts or populated unbound archives require a new directory.
- Terminal status is preserved; operational errors and relink-required states reject the sync command. Reconnect callbacks are guarded, release the writer lock on failure, and do not create unhandled timer exceptions.
- Added offline actual-entrypoint lifecycle tests with Node module mocks: stalled media with durable credential/delete events, abort/cleanup, terminal logout, reconnect failure, stale socket rejection, same-account device suffix, account mismatch, plus config rewrite tests.

Validation after fixes: `npm run check` passed before round 3. No account linkage or real session credentials were involved; auth test rows are synthetic marker data.
