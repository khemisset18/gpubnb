import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApiServer } from "../src/server.mjs";

async function withServer(server, fn) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    return await fn(address.port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(port, { method = "GET", path = "/", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: { host: "asset-exchange.test", ...headers }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("health endpoint exposes only minimal non-sensitive status", async () => {
  const server = createApiServer();
  await withServer(server, async (port) => {
    const res = await request(port, { path: "/healthz" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.deepEqual(JSON.parse(res.body), { status: "ok", service: "asset-exchange-api" });
  });
});

test("readiness failures are generic and do not leak exception details", async () => {
  const server = createApiServer({
    readinessProbe: async () => {
      throw new Error("postgres password=super-secret internal-host=10.0.0.5");
    }
  });

  await withServer(server, async (port) => {
    const res = await request(port, { path: "/readyz" });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.includes("super-secret"), false);
    assert.equal(res.body.includes("10.0.0.5"), false);
  });
});

test("business routes fail closed because none are enabled yet", async () => {
  const server = createApiServer();
  await withServer(server, async (port) => {
    for (const path of ["/offers", "/trades", "/settlement", "/admin"]) {
      const res = await request(port, { path });
      assert.equal(res.statusCode, 404);
    }
  });
});

test("health endpoints reject non-GET methods", async () => {
  const server = createApiServer();
  await withServer(server, async (port) => {
    const res = await request(port, { method: "POST", path: "/healthz" });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, "GET");
  });
});

test("oversized request target is rejected", async () => {
  const server = createApiServer();
  await withServer(server, async (port) => {
    const res = await request(port, { path: "/" + "a".repeat(2050) });
    assert.equal(res.statusCode, 414);
  });
});

test("readiness probe is time-bounded", async () => {
  const server = createApiServer({
    readinessProbe: async () => new Promise(() => {}),
    readinessTimeoutMs: 25
  });
  await withServer(server, async (port) => {
    const started = Date.now();
    const res = await request(port, { path: "/readyz" });
    const elapsed = Date.now() - started;
    assert.equal(res.statusCode, 503);
    assert.ok(elapsed < 1000);
  });
});
