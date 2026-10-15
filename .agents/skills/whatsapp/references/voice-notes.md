# Voice notes

## Retrieve the right recordings

Resolve the chat and read the requested window through the main skill first. For notes received from a named person, select incoming audio (`fromMe:false`); for the user's own notes, select outgoing audio. Include both directions when asked for all voice notes in a conversation. Clarify direction only if the request is ambiguous and it affects selection. Do not equate latest with unread; these tools do not expose reliable unread state. If the user expects three notes and only two are received, state the gap instead of choosing an unrelated third recording.

Run the exporter from the project root, using only stable IDs selected from those results:

```sh
node .agents/skills/whatsapp/scripts/export-voice-notes.mjs --config /absolute/config.json MESSAGE_ID [MESSAGE_ID ...]
```

It uses existing archive authorization and the bounded WhatsApp media downloader. It opens no account session and sends no read/played receipts. It rechecks authorization, deletion, and descriptor revision after downloading. It creates a new private directory under the configured data directory's `voice-notes/` and prints a manifest path. It does not prove live freshness; the preceding MCP read provides that observation. Expired media returns an error; do not request reupload or re-pair automatically.

The export is all-or-nothing: a failed batch removes its partial working directory. Existing exports remain untouched. Already-exported files are local copies, not live authorization checks; revalidate scope and message availability before reusing them for a later user request.

## Transcribe locally

Use the installed Python environment with `mlx-whisper` and FFmpeg (see **Local setup**, linked from SKILL.md). Run:

```sh
python .agents/skills/whatsapp/scripts/transcribe.py /absolute/manifest.json --data-dir /configured/private/data --language es
```

Choose `en` for known English, `es` for known Spanish, `auto` when unknown, or `mixed` for known English/Spanish switching. `mixed` uses automatic detection; Whisper detects a dominant language and can normalize language switches, so inspect the result and recheck affected passages before claiming verbatim preservation. Do not force Spanish just because someone lives in Colombia.

The default is the pinned full `mlx-community/whisper-large-v3-mlx` snapshot already downloaded on this Mac. `--model /absolute/local/model` can select another locally installed MLX Whisper model. The script accepts local model files only and disables Hugging Face network downloads and telemetry. It never installs dependencies, fetches weights, or uploads audio. A missing model/runtime produces an actionable error.

Input is the export manifest: a nonempty array of `{messageId, chatId, senderId, sentAt, path, sha256}`. Paths are relative to the manifest directory. Set `--data-dir` to the approved WhatsApp config's resolved `dataDir`, not an arbitrary shared folder. The script accepts only `voice-notes/export-*` working directories under that root and verifies private directory permissions. Preserve unknown sender identity as null; never invent a name from the voice. Each file is checked against its SHA-256 before transcription. Maximum 25 MiB and 30 minutes per recording; longer inputs fail without claiming partial success. Decoder errors fail the operation rather than returning a partial transcript. A cleanly decodable but already-truncated source cannot always be detected, so compare the measured duration against the message metadata when available.

Output is a separate private `transcript-*.json` beside the manifest: source metadata, model path, runtime version, language mode, elapsed times, full raw text, timestamped segments/words, and quality flags. Original audio and earlier transcripts remain unchanged. A failure produces no completed transcript file.

## Verify before translating

1. Start without vocabulary hints or supplied names. Inspect all segments for omissions, repetitions, invented words, language switches, and low-quality flags. Model log probabilities are diagnostics, not calibrated certainty.
2. Check names, numbers, negations, pronouns, currency, payment period, and wording that changes obligations even when model diagnostics look good.
3. When wording is unclear, rerun with `--context-check` to retain previous-window context. Compare the entire statement, not just the most fluent candidate. Whole-recording context can work better than isolated short clips. Agreement between passes is supporting evidence, not independent human verification.
4. If relevant uncertainty remains, mark `[unclear 00:12–00:16]`. Do not choose a disputed name because it matches a contact. Silence is not text; repeated stock phrases can be hallucinations. If no reliable speech is recognized, say so.
5. For mixed speech, compare full-recording `en` and `es` passes only where needed, and preserve uncertainty if they disagree. Do not call a translated/normalized Spanish passage an English verbatim transcript.

## Deliver

For each note, show sender (when resolved), sent time with timezone, duration, and source ID. English: full English transcript. Spanish: full Spanish and natural English side by side. Mixed: original with language switches preserved where supported, plus complete English translation. Add punctuation for readability; identify any removal of fillers and do not silently omit substantive content.

Keep raw recognition results separate from editorial punctuation, corrected wording, and translation. Explain unresolved alternatives and interpretation separately. A translation can be natural without making an ambiguous payment, promise, date, or amount definite.
