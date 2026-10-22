import assert from "node:assert/strict";
import test from "node:test";
import { IngestError } from "../src/errors.ts";
import { assertPublicUrl, isBlockedIp, safeFetch } from "../src/ssrf.ts";

test("blocks private, metadata, credential, and odd-port destinations before any fetch", async () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://127.1/secret",
    "http://2130706433/",
    "http://169.254.169.254/latest",
    "http://10.0.0.8/",
    "http://192.168.1.9/",
    "http://[::1]/",
    "http://localhost/admin",
    "file:///etc/passwd",
    "http://user:pass@8.8.8.8/",
    "https://example.com:22/",
    "http://metadata.google.internal/",
  ];
  for (const url of blocked) {
    assert.throws(() => assertPublicUrl(url), IngestError, url);
  }
  assert.equal(isBlockedIp("::ffff:7f00:1", 6), true);
  assert.equal(isBlockedIp("8.8.8.8", 4), false);
  let calls = 0;
  await assert.rejects(
    safeFetch("http://127.0.0.1/secret", {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      fetchImpl: async () => {
        calls += 1;
        return new Response("no");
      },
    }),
    (error: unknown) => error instanceof IngestError && error.code === "ssrf_blocked",
  );
  assert.equal(calls, 0);
});

test("does not follow a redirect onto a private address", async () => {
  const calls: string[] = [];
  await assert.rejects(
    safeFetch("https://archive.northglass.example/start", {
      lookup: async (hostname) => {
        if (hostname === "archive.northglass.example") return [{ address: "8.8.8.8", family: 4 }];
        return [{ address: "127.0.0.1", family: 4 }];
      },
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/latest" } });
      },
    }),
    (error: unknown) => error instanceof IngestError && error.code === "ssrf_blocked",
  );
  assert.deepEqual(calls, ["https://archive.northglass.example/start"]);
});

test("caps response bodies", async () => {
  const big = new Uint8Array(1_500_001);
  await assert.rejects(
    safeFetch("https://archive.northglass.example/big", {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetchImpl: async () => new Response(big, { status: 200, headers: { "content-type": "text/plain" } }),
    }),
    (error: unknown) => error instanceof IngestError && error.code === "response_too_large",
  );
});
