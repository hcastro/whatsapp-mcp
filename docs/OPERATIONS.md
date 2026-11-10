# Running the connector

One sync process owns the linked WhatsApp session. MCP clients run separate `serve` processes against the same configured data directory. The application does not install a background service or edit the MCP host's configuration.

## Configuration

All CLI commands accept `--config /absolute/config.json`. Without it, they use `config.json` in the working directory. Paths inside the file resolve relative to the file's directory.

| Field | Behavior |
| --- | --- |
| `dataDir` | Required private storage directory, normally `.local` |
| `access` | `account` or `selected`; omitted means `selected` |
| `allowedChats` | Required array of exact authorized IDs in selected mode, up to 500 entries |
| `cacheMedia` | Optional eager media cache, default `false` |
| `maxMediaBytes` | Eager-cache size limit, 1 byte to 4 MiB; default 4 MiB |

`init` creates a new account-mode configuration only when the file does not exist. The checked-in [example](../config.example.json) explicitly uses selected mode. An empty selected allowlist discards all message bodies, so configure it before initial history delivery.

Account mode retains available conversation data for later user-directed reads. Selected mode retains chat/contact metadata, then discards unselected bodies and download descriptors before persistence. WhatsApp may deliver broader data to the linked device before that filter runs. Selection cannot restore previously discarded history.

Configuration is rechecked on every operation and after asynchronous work. Revocation blocks retrieval but does not securely erase stored data. Changing `dataDir` requires restarting the processes that use it.

## CLI commands

| Command | Purpose |
| --- | --- |
| `help` | Print commands without opening an archive |
| `init` | Create configuration when missing and initialize the offline archive |
| `link --accept-unofficial-client` | Pair interactively, save credentials and continue syncing |
| `sync` | Resume saved credentials and receive updates |
| `serve` | Serve MCP over stdio; stdout belongs to the protocol |
| `chats` | Print discovered chat IDs and metadata for configuration |

`link` requires an interactive terminal and prior account-owner approval. It is an initial pairing or deliberate reauthorization step. Ordinary startup uses `sync` without a QR. Stop an active `link` process before starting `sync`.

## MCP host registration

Find your Node executable with `command -v node` and use its absolute path. A Codex configuration entry has this form:

```toml
[mcp_servers.whatsapp]
command = "/absolute/path/to/node"
args = ["/absolute/whatsapp-mcp/dist/cli.js", "serve", "--config", "/absolute/whatsapp-mcp/config.json"]
```

The host launches `serve`; keep `sync` running separately. The SDK supports modern MCP and tested legacy clients. Image previews require an image-capable client.

After rebuilding, restart the host's MCP connection to discover new tools. Restart the existing sync process to load changes in sync or history handling. A fresh MCP/SDK client can connect to the existing writer without starting another linked-device session.

## Startup and shutdown

1. Check whether a sync writer already owns the configured data directory.
2. Start `sync` only if it is stopped, using the existing configuration and credentials.
3. Start or reconnect the MCP host and check `read_conversation` for the directed chat.
4. Stop a foreground process with Ctrl-C, or send SIGTERM to its verified PID.

An exclusive `sync.lock` records the writer PID. If startup reports an existing lock, verify that PID and command before removing anything. Recover a stale lock only after confirming its writer stopped. Multiple MCP readers are supported; a second sync writer is not.

## Troubleshooting

| Symptom | Check and next step |
| --- | --- |
| Live read fails | Check `sync_coverage`, heartbeat age and the sync process. A cached search alone does not verify connectivity. |
| Connected but recent text is missing | Use the [explicit recent recovery workflow](USAGE.md#missing-history), then compare with the phone or desktop conversation. |
| Older page is empty | Preserve the cursor, request older recovery and retry that boundary after delivery. |
| `recover_history` is absent | Rebuild and reconnect the MCP host. Discover schemas in a fresh client before calling the tool. |
| A dependency patch check fails | Restore the pinned install with `npm ci --ignore-scripts`, then build. Review changed upstream source before modifying a guard. |
| Ordinary sync requests a QR | Stop and inspect account-owner authorization and the phone's linked-device list before deliberate relinking. |
| A download fails | Check current authorization, deletion/edit state, availability and the attachment limits. Expired-media reupload is unsupported. |
| Data directory or account binding fails | Restore the intended config and account/archive pairing. Do not reset credentials or bypass the binding check. |

Transient disconnects retry with a delay capped at 60 seconds. Pairing's 515 restart reconnects immediately. Code 500 also retries with saved credentials because it can represent a stream-ack failure. Logout, replaced connection, multidevice mismatch and forbidden access stop the process. A numeric 500 by itself does not establish that credentials need replacing.

## Storage and revocation

| Local artifact | Contents |
| --- | --- |
| `archive.sqlite` and SQLite sidecars | Chat/contact metadata, messages, sync observations and sensitive attachment descriptors |
| `auth.sqlite` and SQLite sidecars | Linked-account credentials and protocol session keys |
| `sync.lock`, `live.sock` | Writer ownership and private local IPC |
| `voice-notes/` | Private exported audio and transcript evidence from the optional skill |

Directories use mode 0700 and private files use 0600. Stored data is not application-level encrypted; use host disk encryption such as FileVault. Stop all readers and the writer before making a consistent filesystem backup, and preserve permissions and SQLite sidecars. Deleting local files does not revoke the linked device: unlink it from the primary phone.
