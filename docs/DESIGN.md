# Connected reading contract

A successful live read must verify the current authenticated WhatsApp connection, recheck chat authorization, and return all locally received updates for the requested page. It must disclose historical gaps. The linked-device protocol does not offer a guaranteed arbitrary query of the phone's entire message database.

## Design alternatives

A single socket-owning MCP would simplify startup but mix credentials, reconnect lifecycle and arbitrary dependency capabilities into the model-facing process. An isolated offline MCP provided strong separation but could not request missing data and failed the intended user experience.

The chosen design retains one socket-owning sync service and adds private local IPC with exactly two validated operations: conversation read and attachment read. `connected.ts` owns freshness, on-demand retrieval and revalidation. `live.ts` owns framing, bounds, errors and socket lifecycle. MCP translates those operations and does not receive credentials or raw download descriptors. SQLite is the durable query index, not a claim of complete account history.

## Invariants

- Account-bound archive; account or selected-chat authorization checked before network requests and after asynchronous work. Account scope retains available conversation data and supports any user-directed chat; selected scope applies an exact allowlist.
- One sync writer; no socket replacement during a successful live read. Authenticated ping response is required.
- Live errors are distinct from empty results. Requesting history does not establish delivery or completeness.
- Chat-scoped history requests are bounded and throttled. Empty conversations have no invented message IDs. Account mode permits throttled full-account history recovery after an empty chat-scoped request; selected mode does not. User approval for full-history recovery and account-wide user-directed reading precedes enabling account mode.
- Full history batches delivered by WhatsApp are accepted by the sync adapter, then filtered before content persistence.
- Stable message IDs, deduplication, edit revisions and deletion tombstones remain archive-owned.
- Attachment source descriptors are scoped to configured authorization, schema-migrated transactionally, and invalidated by edits/deletions. They are never exposed through MCP.
- Attachment reads accept IDs and section selectors, never filesystem paths or URLs. Downloads and parsing are bounded; macros and document scripts are not executed. Images and PDF previews are returned as image content, documents as extracted content.
- No application message sending, read marking, presence or account/group management. Protocol acknowledgments and history synchronization remain necessary.

## Ownership and verification

`sync.ts` owns the linked session and event ingestion. `connected.ts` coordinates authorized live operations. `live.ts` owns local IPC. `archive.ts` owns persistence/authorization. `attachments.ts` isolates parsing and its deadline; `attachment-worker.ts` owns supported formats and expansion limits. `server.ts` owns MCP schemas. Configuration selection remains deliberate user configuration.

The strategic-code-design and code-comments skills guide implementation and review. Review requests use the exact personal review rubric. Tests verify changed contracts, including revocation during asynchronous reads, stale-socket rejection, newest-first pagination with chronological presentation, actual document/image parsers, and real MCP stdio clients. Live acceptance remains separately documented; synthetic success is not proof of recovered phone history.
