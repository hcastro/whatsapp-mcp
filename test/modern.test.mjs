import { test } from "node:test";
import assert from "node:assert/strict";
import { stdioFixture } from "./support/stdio.mjs";

const modern = (params = {}, version = "2026-07-28") => ({
  ...params,
  _meta: {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": {
      name: "wire-fixture",
      version: "1",
    },
  },
});

const checkComplete = (result) => {
  assert.equal(result.resultType, "complete");
  assert.equal(
    result._meta["io.modelcontextprotocol/serverInfo"].name,
    "whatsapp-readonly",
  );
};

test(
  "modern stdio discovery, private uncached schemas, errors and reads without initialization",
  { timeout: 10000 },
  async (t) => {
    const fixture = stdioFixture(t);
    const wrongVersion = await fixture.request(
      "tools/list",
      modern({}, "2099-01-01"),
    );
    assert.equal(wrongVersion.error.code, -32022);
    const discovery = await fixture.request("server/discover", modern());
    assert.deepEqual(discovery.result.supportedVersions, ["2026-07-28"]);
    checkComplete(discovery.result);
    const listed = await fixture.request("tools/list", modern());
    checkComplete(listed.result);
    assert.equal(listed.result.ttlMs, 0);
    assert.equal(listed.result.cacheScope, "private");
    assert.equal(listed.result.tools.length, 5);
    for (const tool of listed.result.tools) {
      assert.ok(tool.outputSchema);
      assert.equal(tool.annotations.readOnlyHint, true);
    }
    const missingMeta = await fixture.request("tools/call", {
      name: "sync_coverage",
      arguments: {},
    });
    assert.ok(missingMeta.error);
    const result = (
      await fixture.request(
        "tools/call",
        modern({ name: "search_messages", arguments: {} }),
      )
    ).result;
    checkComplete(result);
    assert.deepEqual(
      result.structuredContent,
      JSON.parse(result.content[0].text),
    );
    assert.equal(result.structuredContent.coverage.complete, false);
    assert.equal(fixture.hasCredentials(), false);
    fixture.child.stdin.end();
    assert.deepEqual(await fixture.exited, { code: 0, signal: null });
  },
);

test(
  "discovery followed by legacy initialization creates a usable replacement archive",
  { timeout: 10000 },
  async (t) => {
    const fixture = stdioFixture(t);
    assert.ok((await fixture.request("server/discover", modern())).result);
    const initialized = await fixture.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "fallback-fixture", version: "1" },
    });
    assert.equal(initialized.result.protocolVersion, "2025-11-25");
    fixture.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const response = await fixture.request("tools/call", {
      name: "sync_coverage",
      arguments: {},
    });
    assert.equal(response.result.isError, undefined);
    assert.equal(response.result.structuredContent.complete, false);
    fixture.child.stdin.end();
    assert.deepEqual(await fixture.exited, { code: 0, signal: null });
  },
);

for (const shutdown of ["EOF", "SIGINT", "SIGTERM"]) {
  for (const opened of [false, true]) {
    test(
      `stdio ${shutdown} exits cleanly ${opened ? "after modern call" : "before a server instance opens"}`,
      { timeout: 10000 },
      async (t) => {
        const fixture = stdioFixture(t);
        if (opened)
          assert.ok((await fixture.request("tools/list", modern())).result);
        // An unsupported probe confirms signal handlers are installed without opening an archive.
        else if (shutdown !== "EOF")
          await fixture.request("server/discover", modern({}, "2099-01-01"));
        if (shutdown === "EOF") fixture.child.stdin.end();
        else fixture.child.kill(shutdown);
        assert.deepEqual(await fixture.exited, { code: 0, signal: null });
        assert.equal(fixture.hasCredentials(), false);
      },
    );
  }
}
