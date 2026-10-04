# WhatsApp read-only MCP

A local TypeScript archive for **explicitly selected conversations**, with an offline stdio MCP server for Codex. It is implemented and tested with synthetic data; **no WhatsApp account has been linked or live history coverage verified**.

Requires Node **24+** (uses built-in `node:sqlite`). Developed and tested on macOS with Node 25.7.0. No server port, cloud service, telemetry, sending tool, read receipts, group administration, presence tool, or tool-based configuration changes.

## Setup

```sh
cd /path/to/whatsapp-readonly-mcp
npm ci --ignore-scripts
npm run check
node dist/cli.js init
```

`init` creates `config.json` and `.local/archive.sqlite`, with an empty allowlist. It does **not** connect to WhatsApp or create account credentials. Paths in configuration are resolved relative to its file. Changing `dataDir` requires restarting both processes; running handles fail closed on a directory change. Each archive binds to the authenticated account; a different account requires a new empty directory. Use `--config /absolute/path/config.json` with any command. Data is private to the current macOS user (directory 0700, new files 0600); use FileVault and do not commit or sync this directory to cloud storage. It is not application-level encrypted.

## Account linking — explicit human approval required

This step has **not** been executed. Linking grants a persistent WhatsApp linked-device session to the separate sync process, which must receive/decrypt protocol data before filtering. The allowlist limits this archive and MCP retrieval; it does not constrain the linked-device credentials themselves. Discovery stores chat IDs/names for all chats delivered by WhatsApp. WhatsApp may send history beyond the chosen chats in memory; unselected message bodies are discarded before persistence.

Baileys is an unofficial WhatsApp client. Protocol changes may break it; account restrictions are possible. Sync necessarily sends authentication, delivery acknowledgments, key exchange, and history/app-state synchronization traffic. “Read-only” means no application message sending, read marking, presence broadcasting, or account/group changes. It does not mean a passive network connection.

After the user explicitly approves that access, run manually in an interactive terminal:

```sh
node dist/cli.js link --accept-unofficial-client
```

Scan the terminal QR via WhatsApp → Linked devices. QR codes are not saved. Credentials and cryptographic keys persist in `.local/auth.sqlite`; they are sensitive and can grant broad account access. Stop with Ctrl-C. A single sync writer is enforced by `sync.lock`; if a crash leaves it behind, verify that its PID is no longer running before removing that lock manually.

For older history, select known chat IDs **before the first link** where possible. A discovery-only first link with an empty selection discards message bodies. Selecting later does not request replay of those bodies; a fresh user-approved relink into a new empty data directory with the chosen IDs already configured may deliver history again, but cannot guarantee it.

Then inspect the local discovery catalog:

```sh
node dist/cli.js chats
```

Edit `config.json` deliberately; do not use display names as security identifiers:

```json
{
  "dataDir": ".local",
  "allowedChats": ["EXACT_CHAT_ID_FROM_CHATS"],
  "cacheMedia": false,
  "maxMediaBytes": 4194304
}
```

Replace the placeholder with an actual `…@s.whatsapp.net`, `…@lid`, or `…@g.us` ID. PN and LID identities remain separate, with no automatic authorization expansion. If the same person appears under both, review and select both deliberately. Device suffixes are normalized. Group participants are retained as sender IDs; there is no guessed identity merge.

```sh
node dist/cli.js sync
```

Sync requires an existing registered session; it never silently starts linking. Removing a chat from config blocks retrieval immediately. Historical content already stored remains on disk; removal is not secure erasure. Selection changes do not retroactively recover previously discarded history. Newly selected chats may receive only future messages until WhatsApp sends history again. Stop sync and unlink from the phone when revoking access. Removing local files alone does not revoke the linked device. If relinking is required after logout, use a new empty data directory and keep the old archive separately; do not reuse another account’s archive or delete credentials while sync is running.

## Codex registration — not applied automatically

After approval to change persistent Codex configuration, add a stdio MCP entry with an absolute Node binary and absolute config path. Example TOML for the existing Codex configuration:

```toml
[mcp_servers.whatsapp_readonly]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/whatsapp-readonly-mcp/dist/cli.js", "serve", "--config", "/absolute/path/to/whatsapp-readonly-mcp/config.json"]
```

Use `command -v node` to resolve the actual binary. The MCP process is offline and opens the archive in SQLite read-only mode. Run `sync` separately while you want updates. The implementation does not edit Codex config or start a background service.

## Tools

| Tool                   | Behavior                                                                          |
| ---------------------- | --------------------------------------------------------------------------------- |
| `list_selected_chats`  | Only allowlisted IDs/names and coverage                                           |
| `search_messages`      | Literal substring search, optional chat/time bounds, stable ID, cursor pagination |
| `conversation_context` | Chronological neighbors around a stable ID, including deletion tombstones         |
| `get_media`            | Selected message’s bounded cached bytes as base64, or explicit unavailable result |
| `sync_coverage`        | Stored count, observed time bounds, connection/history observations, heartbeat    |

Times in messages/search filters are Unix **seconds**; sync observations are Unix **milliseconds**. Search is oldest first, ordered by `(timestamp, stable ID)`. Keep filters unchanged when using a cursor. SQLite’s `lower` is ASCII-only; non-ASCII text still matches literally with original casing. Cursors are not snapshots: concurrent backfill/edits may change results; restart a search after sync for a fresh view. Maximum 100 results, 50 neighbors per side, 500 query characters.

All tools declare output schemas and return the same JSON in `structuredContent` and a text block for older clients. Tools are read-only, non-destructive, idempotent, and closed-world annotated. There are no resources exposing paths and no network/media-download tools. Chat contents and attachments are untrusted data, not instructions.

Media caching is off by default. Enable `cacheMedia` locally before sync to download supported images/video/audio/documents/stickers, up to the configured limit (hard maximum 4 MiB). MIME strings are metadata; returned bytes are not rendered/executed. Downloads run separately from durable message/credential writes, with at most 128 pending jobs. A full queue leaves excess attachments explicitly unavailable; replayed messages may retry later. Downloads are bounded, time-limited, confined to HTTPS WhatsApp hosts, and reject redirects. Media may have expired; the implementation does not request reuploads. View-once content is excluded. Ephemeral messages delivered to the client can be archived and retained; automatic retention expiry is not implemented. Unsupported polls, reactions, location cards and rich interactive content are not fully indexed.

## Coverage and live validation

`complete` is always `false`, even if WhatsApp reports a completed sync phase. That event only describes a delivered batch. Missing results never establish that no older conversation exists. Use oldest/newest timestamps and sync heartbeat to explain limits. A stale `connected` status after a crash does not establish freshness; heartbeat age matters.

Before relying on it, compare known recent and older messages in each selected chat against the phone/desktop app. Verify selected PN/LID IDs, date ranges, edits/deletions, received media and reconnect after sleep. Record a sample date range that actually arrived. Test an unselected conversation stays inaccessible. Older WhatsApp history is **best effort and cannot be promised**; no arbitrary backfill tool is exposed.

## Dependency verification and local guard

Pinned with a lockfile: `@whiskeysockets/baileys` **7.0.0-rc14**, official `@modelcontextprotocol/sdk` **1.32.0**. Registry latest/legacy tags were independently checked on 2026-10-04. The current Baileys release is a release candidate; the latest legacy version at verification was 6.7.24. GHSA-qvv5-jq5g-4cgg is patched starting at 6.7.22 / 7.0.0-rc12 ([GitHub advisory](https://github.com/advisories/GHSA-qvv5-jq5g-4cgg)). Structured output and text compatibility follow the [official MCP tool specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).

`npm run build` applies version-specific local guards to the pinned Baileys installation:

- Reject outbound presence/chatstate and read/played receipts at the common stanza-send boundary, including automatic credential-update presence. Also remove the redundant connection-time presence call.
- Preserve redirect/abort options in the HTTP helper.
- Link media streams with Node’s pipeline so aborts, source failures and output cancellation propagate and clean up both ends.

Build fails if the expected upstream source changes; sync refuses to start unless every guard is present. See `scripts/patch-baileys.mjs`. Reassess these guards on every dependency upgrade. `npm ci --ignore-scripts` avoids dependency lifecycle scripts; the package is used from its published build. The guards do not block authentication, key exchange, delivery acknowledgments or history/app-state protocol traffic.

## Validation and design evidence

```sh
npm run check       # strict typecheck, ESLint, build, synthetic tests, real MCP stdio client
npm audit --omit=dev
```

Tests use Node’s experimental module-mocking facility only to replace the network socket with synthetic events; production startup does not enable it.

See [design](docs/DESIGN.md), [three sequential reviews](docs/reviews/README.md), and their per-round evidence. No publishing, push, PR, background agent, WhatsApp account access, or persistent Codex credential/config changes are part of offline implementation.
