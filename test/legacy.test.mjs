import { test } from "node:test";
import assert from "node:assert/strict";
import { stdioFixture } from "./support/stdio.mjs";

for (const version of ["2024-11-05", "2025-11-25"]) {
  test(
    `legacy MCP ${version} retains structured/text parity and exits on EOF`,
    { timeout: 10000 },
    async (t) => {
      const fixture = stdioFixture(t);
      const { result: initialized } = await fixture.request("initialize", {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: "legacy-offline-fixture", version: "1" },
      });
      assert.equal(initialized.protocolVersion, version);
      fixture.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const { result } = await fixture.request("tools/call", {
        name: "search_messages",
        arguments: { query: "absent" },
      });
      assert.equal(result.content[0].type, "text");
      assert.equal(result.structuredContent.coverage.complete, false);
      assert.deepEqual(
        JSON.parse(result.content[0].text),
        result.structuredContent,
      );
      assert.equal(result.resultType, undefined);
      assert.equal(fixture.hasCredentials(), false);
      fixture.child.stdin.end();
      assert.deepEqual(await fixture.exited, { code: 0, signal: null });
    },
  );
}
