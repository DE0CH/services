"use strict";
const test = require("node:test");
const assert = require("node:assert");
process.env.SESSION_HOST_SUFFIX = "-s.deyaochen.com";
const { parseMount, rewriteLocation, rewriteCookie, cacheable } = require("../lib/server.js");

const ID = "sc72b5bfc6964367a";

test("session paths: only a real session id mounts", () => {
  assert.deepStrictEqual(parseMount(`/s/${ID}/api/session/create`), { id: ID, rest: "/api/session/create" });
  assert.deepStrictEqual(parseMount(`/s/${ID}/?token=x`), { id: ID, rest: "/?token=x" });
  assert.strictEqual(parseMount("/s/evil.example.com/"), null);
  assert.strictEqual(parseMount("/s/SC72B5BFC6964367A/"), null);
  assert.strictEqual(parseMount("/other"), null);
});

test("redirects stay under the mount", () => {
  assert.strictEqual(rewriteLocation("/?token=abc", ID), `/s/${ID}/?token=abc`);
  assert.strictEqual(rewriteLocation(`https://${ID}-s.deyaochen.com/x`, ID), `/s/${ID}/x`);
  assert.strictEqual(rewriteLocation("./", ID), "./");
  assert.strictEqual(rewriteLocation("//elsewhere/x", ID), "//elsewhere/x");
  assert.strictEqual(rewriteLocation("https://other.example/x", ID), "https://other.example/x");
});

test("cookies are scoped to the session's mount", () => {
  assert.strictEqual(rewriteCookie("dsh=1; Path=/; HttpOnly; Secure", ID), `dsh=1; Path=/s/${ID}/; HttpOnly; Secure`);
  assert.strictEqual(rewriteCookie("dsh=1; Domain=x.com; HttpOnly", ID), `dsh=1; HttpOnly; Path=/s/${ID}/`);
});

test("only versioned static files are kept", () => {
  assert.ok(cacheable("GET", "/assets/index-AbCdEf12.js"));
  assert.ok(cacheable("GET", "/plugins/??@deepseek-ai/dsh-x/client.js&rev=3"));
  assert.ok(!cacheable("GET", "/plugins/??@deepseek-ai/dsh-x/client.js"));
  assert.ok(!cacheable("GET", "/"));
  assert.ok(!cacheable("GET", "/api/session/list"));
  assert.ok(!cacheable("POST", "/assets/index-AbCdEf12.js"));
  assert.ok(!cacheable("GET", "/assets/logo.svg"));
});
