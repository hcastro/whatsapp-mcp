# Local setup and recovery

The project's [operations guide](../../../../docs/OPERATIONS.md) covers configuration and process management. The [usage guide](../../../../docs/USAGE.md) covers tool schemas, pagination and explicit history recovery.

The skill lives at `.agents/skills/whatsapp` in the WhatsApp MCP checkout. Run the Node exporter from that checkout with Node 24+. Build dependencies and `dist/` must already exist (`npm run build` after dependency setup). The helper imports the project's existing archive and media modules; do not copy credentials or create another socket session.

## MCP availability

Inspect available tools before invoking a prefix. `whatsapp:read_conversation` in this skill names the logical tool on the WhatsApp server, not a guarantee of how the client spells it.

If no registered tools are exposed, a local MCP client can launch the existing stdio server:

```sh
node dist/cli.js serve --config /absolute/config.json
```

Use the installed official MCP client SDK and discover tool schemas. Keep protocol stdout clean. For live reads, check whether the sync process is already running before starting one:

```sh
node dist/cli.js sync --config /absolute/config.json
```

Reuse the saved session. Do not run `link`, delete session files, loosen selected-chat restrictions, or alter persistent Codex configuration to fix missing content. Report disconnect/authorization failures accurately. These setup commands do not imply global installation of this skill; repository skills are scoped to the checkout. An agent in another project must read this SKILL.md explicitly or use a separately authorized personal-skill installation.

## Speech runtime

Requires Apple Silicon, Python 3.10+, `mlx-whisper` (tested with 0.4.3), and FFmpeg on PATH. Select an existing trusted environment rather than installing another runtime automatically. Verify the selected Python environment before running transcription:

```sh
python -c 'import mlx_whisper; print(mlx_whisper.__file__)'
```

If the import fails, locate the installed `mlx_whisper` executable and its Python environment; do not download an unrecognized replacement. Check `command -v ffmpeg` and include its installation directory on PATH. Apple Silicon Homebrew commonly uses `/opt/homebrew/bin`.

The transcription script owns the pinned default model location and prints it in `--help`. The model is the MLX Community conversion linked by the [official MLX Whisper guide](https://github.com/ml-explore/mlx-examples/blob/main/whisper/README.md). If absent, report that weights must be downloaded first under applicable permission. It does not fall back to small or a cloud service.

## Storage

Exports and transcript JSON stay under the configured private data directory, with directories mode 0700 and files 0600. They include personal information and are not application-level encrypted. The helper prints paths and counts, not audio bytes or private message bodies. Do not store them in the skill folder, tests, git, or a shared artifact service. A KB capture remains a separate user-directed action.
