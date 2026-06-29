// test/unit/http-router.test.js — contract tests for the first-party HTTP
// router (server/router.js) that replaced Express.
//
// Boots one app exercising every router feature on a random loopback port,
// then asserts routing, params, body parsing, static serving, path-traversal
// rejection, the res.* helpers, and the fault-tolerance guarantees.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import express from "../../server/router.js";

let baseUrl = "";
let server;
let staticRoot;

// http.request is used (not fetch) for the traversal test because fetch
// resolves `..` in the URL client-side before the request is ever sent.
function rawGet(reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: server.address().port, path: reqPath, method: "GET" },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  staticRoot = mkdtempSync(join(tmpdir(), "mmo-router-"));
  writeFileSync(join(staticRoot, "hello.txt"), "hello-static");
  writeFileSync(join(staticRoot, "index.html"), "<h1>root index</h1>");
  writeFileSync(join(staticRoot, "overlay.html"), "<h1>overlay</h1>");
  mkdirSync(join(staticRoot, "shared"));
  writeFileSync(join(staticRoot, "shared", "sim.js"), "export const x = 1;");
  const overlayFile = join(staticRoot, "overlay.html");

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1kb" }));
  app.use((_req, res, next) => {
    res.set("X-Test", "on");
    next();
  });

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/api/echo/:name", (req, res) => res.json({ name: req.params.name }));
  app.get("/sig", (req, res) => res.json({ sig: req.get("X-Sig") || null }));
  app.get("/overlay", (_req, res) => res.sendFile(overlayFile));
  app.get("/boom", () => {
    throw new Error("handler blew up");
  });
  // A handler that neither answers nor throws — mimics a guard()-swallowed
  // throw. The router must turn the silence into a 500, never a hang.
  app.get("/silent", () => {});

  app.post("/api/json-body", (req, res) => res.json({ body: req.body }));
  app.post("/api/teapot", (_req, res) => res.status(418).json({ error: "teapot" }));
  app.post("/api/raw", express.text({ type: "*/*", limit: "1kb" }), (req, res) =>
    res.json({ raw: req.body, isString: typeof req.body === "string" }),
  );

  app.use(express.static(staticRoot));
  app.use("/assets", express.static(join(staticRoot, "shared")));

  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(staticRoot, { recursive: true, force: true });
});

describe("router — routing & params", () => {
  test("GET route returns JSON with 200", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("application/json"));
    assert.deepEqual(await res.json(), { ok: true });
  });

  test("captures a :param segment", async () => {
    const res = await fetch(`${baseUrl}/api/echo/sigmachad`);
    assert.equal((await res.json()).name, "sigmachad");
  });

  test("decodes a percent-encoded :param", async () => {
    const res = await fetch(`${baseUrl}/api/echo/a%20b`);
    assert.equal((await res.json()).name, "a b");
  });

  test("unmatched route returns 404", async () => {
    const res = await fetch(`${baseUrl}/no/such/route`);
    assert.equal(res.status, 404);
  });

  test("res.status() sets the response code", async () => {
    const res = await fetch(`${baseUrl}/api/teapot`, { method: "POST" });
    assert.equal(res.status, 418);
  });

  test("req.get() reads a request header case-insensitively", async () => {
    const res = await fetch(`${baseUrl}/sig`, { headers: { "X-Sig": "abc123" } });
    assert.equal((await res.json()).sig, "abc123");
  });
});

describe("router — body parsing", () => {
  const post = (path, body, contentType) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });

  test("parses a JSON body into req.body", async () => {
    const res = await post("/api/json-body", JSON.stringify({ a: 1 }), "application/json");
    assert.deepEqual((await res.json()).body, { a: 1 });
  });

  test("malformed JSON degrades to an empty body, not a crash", async () => {
    const res = await post("/api/json-body", "{not valid", "application/json");
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).body, {});
  });

  test("a non-JSON content-type leaves req.body empty", async () => {
    const res = await post("/api/json-body", JSON.stringify({ a: 1 }), "text/plain");
    assert.deepEqual((await res.json()).body, {});
  });

  test("a JSON body over the configured limit is rejected with 413", async () => {
    const big = JSON.stringify({ pad: "x".repeat(2000) });
    const res = await post("/api/json-body", big, "application/json");
    assert.equal(res.status, 413);
  });

  test("text() exposes the raw body as a string", async () => {
    const res = await post("/api/raw", "hello raw", "text/plain");
    const out = await res.json();
    assert.equal(out.raw, "hello raw");
    assert.equal(out.isString, true);
  });

  test("a text body over the configured limit is rejected with 413", async () => {
    const res = await post("/api/raw", "x".repeat(2000), "text/plain");
    assert.equal(res.status, 413);
  });
});

describe("router — static & sendFile", () => {
  test("serves a static file with the right content-type", async () => {
    const res = await fetch(`${baseUrl}/hello.txt`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/plain"));
    assert.equal(await res.text(), "hello-static");
  });

  test("serves index.html for a directory request", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("root index"));
  });

  test("a mounted static root serves under its prefix", async () => {
    const res = await fetch(`${baseUrl}/assets/sim.js`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/javascript"));
    assert.equal(await res.text(), "export const x = 1;");
  });

  test("res.sendFile sends a file with an inferred content-type", async () => {
    const res = await fetch(`${baseUrl}/overlay`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/html"));
    assert.ok((await res.text()).includes("overlay"));
  });

  test("a missing static file falls through to 404", async () => {
    const res = await fetch(`${baseUrl}/not-a-real-file.png`);
    assert.equal(res.status, 404);
  });

  test("path traversal out of the static root is rejected", async () => {
    const res = await rawGet("/../../package.json");
    assert.equal(res.status, 404);
    assert.ok(!res.body.includes("sigmashake-mmo"));
  });
});

describe("router — middleware & fault tolerance", () => {
  test("global middleware runs and next() continues the chain", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.headers.get("x-test"), "on");
  });

  test("x-powered-by is never set", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.headers.get("x-powered-by"), null);
  });

  test("a throwing handler yields 500 instead of hanging", async () => {
    const res = await fetch(`${baseUrl}/boom`);
    assert.equal(res.status, 500);
  });

  test("a handler that answers nothing still yields a 500 response", async () => {
    const res = await fetch(`${baseUrl}/silent`);
    assert.equal(res.status, 500);
  });
});
