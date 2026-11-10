# Developing WhatsApp MCP

Changes should preserve user-directed reads, one sync writer and explicit coverage limits. Start with the [architecture](DESIGN.md), then use the module and test maps below to choose a focused change.

## Local build

Use Node.js 24+ on macOS. The package is ESM TypeScript, compiled into ignored `dist/` output. Dependencies and integrity hashes are pinned in `package-lock.json`.

`package.json` sets `private: true`, so delivery uses a Git checkout and local build rather than npm publication.

```sh
npm ci --ignore-scripts
npm run check
```

The build runs `scripts/patch-baileys.mjs` before TypeScript compilation. That script applies narrow guards to the pinned Baileys/libsignal code and fails if expected source changes. `sync` also verifies the installed guards at startup.

| Command | Checks |
| --- | --- |
| `npm run typecheck` | Strict TypeScript without output |
| `npm run lint` | ESLint over `src/` and `test/` |
| `npm run build` | Guarded dependency patches and TypeScript compilation |
| `npm test` | Build, then Node's test runner with module mocks |
| `npm run check` | Typecheck, lint and the full Node test suite |
| `npm audit --omit=dev` | Current production dependency advisories |
| `npm audit` | Production and development advisories |
| `node scripts/patch-baileys.mjs --check` | Validate installed patches without applying them |

There is no checked-in CI workflow. Run the required checks locally before pushing, and distinguish current results from dated evidence in `docs/`.

## A change through delivery

1. Create a branch from the intended base and inspect the working tree.
2. Reproduce the problem with synthetic fixtures or a focused offline probe. Use temporary data directories.
3. Change the owning module and add a regression test when behavior changes. Keep unrelated code and credentials out of the diff.
4. Run the focused test, then `npm run check`. Check dependency advisories when dependencies change.
5. Update the affected usage/operations contract. Inspect `git diff --check` and explicitly stage the intended files.
6. Create a scoped conventional commit and push the branch. Review and merge remain separate steps.

An isolated CLI smoke test can initialize a temporary directory without pairing:

```sh
scratch_dir=$(mktemp -d)
node dist/cli.js init --config "$scratch_dir/config.json"
node dist/cli.js chats --config "$scratch_dir/config.json"
```

Keep test and development output away from a real account's data directory. `npm run check` does not authorize account linking, reading additional chats or changing a host's persistent configuration.

## Tests by responsibility

| Change area | Relevant tests in `test/` |
| --- | --- |
| Storage, policy, cursors and revisions | `archive`, `adapter`, `contacts`, `contact-recovery` |
| Live IPC, recovery, cancellation and attachments | `live`, `connected`, `history-protocol`, `attachment-lifecycle`, `media-transfer` |
| Sync lifecycle and read-only transport | `lifecycle`, `transport-policy`, `pairing-compatibility`, `wa-version` |
| MCP tools and protocol compatibility | `modern`, `legacy`, `protocol` |
| Voice export and transcription | `voice-notes`, `test_voice_transcription.py` |

Names in the table refer to `.test.mjs` files unless an extension is shown. Run one Node test with:

```sh
node --experimental-test-module-mocks --test test/archive.test.mjs
```

Build first when running a test directly because tests import `dist/`. Tests use temporary synthetic archives and mocked sockets. Production code must continue checking authorization and socket identity after asynchronous work.

## Voice workflow checks

Voice transcription is optional and separate from MCP attachment parsing. Use an existing trusted Python environment with NumPy and FFmpeg for decoder regressions. The full speech workflow additionally needs Apple Silicon, `mlx-whisper` and locally installed full Whisper large-v3 weights.

```sh
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s test -p test_voice_transcription.py -v
```

These tests mock recognition and test local validation/decoding. They do not measure transcription quality. Missing FFmpeg skips decoder regressions. The helper refuses network model downloads, and `--model` can select an approved existing local model directory. See the skill's [setup](../.agents/skills/whatsapp/references/local-setup.md) and [voice workflow](../.agents/skills/whatsapp/references/voice-notes.md).

## Dependency updates

Review the pinned package and its lockfile together. For Baileys or libsignal changes, inspect every guard in `scripts/patch-baileys.mjs` against installed upstream source before adjusting it. Re-run patch checks, transport policy, pairing and lifecycle tests, then the complete suite.

Test modern MCP discovery and legacy initialization after SDK updates. The [SDK migration record](MCP-V2.md) documents the accepted established-connection version limitation. Separate development-tool audit findings from production findings; review proposed major upgrades before using automatic fixes.

## Documentation and diagrams

Use short paragraphs, sentence-case headings and concrete commands. Diagrams should replace an explanation the reader would otherwise have to reconstruct. Edit [the architecture SVG](images/architecture.svg) as vector source and inspect it at normal README width. Keep labels legible, add descriptive alt text, and use Mermaid for small workflow diagrams that GitHub can render directly. Update both the diagram and its supporting text when a boundary changes.

Before sharing a diff, inspect tracked files for account content, machine-specific paths and credentials. Ignore rules do not protect a secret that is already tracked. [Security and diagnostic handling](../SECURITY.md).
