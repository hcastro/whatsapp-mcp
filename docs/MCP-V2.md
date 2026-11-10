# MCP v2 migration

This is the October 4, 2026 migration record. Tool counts and package observations below describe that revision. The current nine-tool contract is in [usage](USAGE.md), with current dependencies pinned in [package.json](../package.json).

## Contract and decision

Serve the official modern `2026-07-28` protocol and retain older stdio clients without changing archive authorization, database schema, account access or tool behavior. All five tools retain output schemas and structured/text parity. No Tasks or elicitation are needed for bounded local retrieval.

Option A: update imports but retain `McpServer.connect(new StdioServerTransport())`. Smallest textual diff, but remains on the legacy wire protocol and does not meet the modern-protocol goal.

Option B: use `serveStdio(factory, { legacy: "serve" })`. The official SDK owns opening classification, modern wire encoding and legacy fallback. Each factory instance owns a separate read-only archive handle and closes it through the server lifecycle. Choose B: protocol knowledge stays in the SDK, while the application retains local ownership of data access and teardown. In particular, discovery followed by legacy initialization can discard one instance and construct another.

## Verification of availability

Direct public npm registry reads on 2026-10-04 returned `@modelcontextprotocol/sdk` latest 1.32.0 and the separately named `@modelcontextprotocol/server` / `client` latest 2.3.0. The prior check of the old package's latest tag missed this split; there was no established client or package-availability blocker requiring v1. Official published v2 archives were downloaded and inspected before migrating. Node 25.7.0 and Zod 4.6.5 satisfy package requirements. Server is a production dependency; client is test-only; versions and integrity are pinned in the lockfile.

Sources: [official SDK](https://github.com/modelcontextprotocol/typescript-sdk), [v2 migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html), [modern opt-in](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html), [stdio lifecycle](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html), [legacy compatibility](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html).

## Wire verification

Real SDK client explicitly pins `2026-07-28` and asserts the modern era, then exercises every tool, output-schema validation, structured/text parity, and live authorization revocation. Raw child-process stdio tests inspect discovery, resultType, server identity metadata, private cache scope and zero TTL, missing metadata rejection, unsupported opening revision rejection, legacy 2024/2025 initialization, modern-to-legacy probe fallback, EOF and signals before/after archive construction. All tests use synthetic local archives; no account credentials are created.

## Known upstream limit

Published SDK 2.3.0 `serveStdio` checks the opening revision but pins an established connection's era. A later `tools/list` carrying `2099-01-01` with otherwise valid modern metadata is processed using the selected modern codec rather than rejected. This was reproduced against the published package; no claim of strict per-request version rejection is made. Missing required metadata still errors. The effect is protocol interoperability, not increased data access: allowlist checks execute inside every archive query independent of transport metadata. No custom wire interception or SDK fork was added for a client changing revisions mid-connection.

Actual Codex-host negotiation remains unverified until persistent registration is approved. The SDK migration neither links WhatsApp nor changes Codex configuration.
