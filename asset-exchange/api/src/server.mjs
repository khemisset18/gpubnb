import http from "node:http";
import { invariant } from "../../core/src/errors.mjs";

const SECURITY_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin"
});

function writeJson(res, statusCode, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    "content-length": String(payload.length),
    ...extraHeaders
  });
  res.end(payload);
}

function validRequestTarget(url) {
  return typeof url === "string" && url.startsWith("/") && url.length <= 2048;
}

function validHost(host) {
  return typeof host === "string" && host.length >= 1 && host.length <= 255 && !/[\r\n]/.test(host);
}

async function runWithTimeout(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation_timeout")), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createApiServer({ readinessProbe = async () => ({ ready: true }), readinessTimeoutMs = 1_000 } = {}) {
  invariant(typeof readinessProbe === "function", "API_READINESS_PROBE", "readinessProbe must be a function");
  invariant(Number.isSafeInteger(readinessTimeoutMs) && readinessTimeoutMs >= 10 && readinessTimeoutMs <= 5_000, "API_READINESS_TIMEOUT", "invalid readiness timeout");

  const server = http.createServer(async (req, res) => {
    try {
      if (!validHost(req.headers.host)) {
        writeJson(res, 400, { error: "bad_request" });
        return;
      }

      if (!validRequestTarget(req.url)) {
        writeJson(res, 414, { error: "request_target_rejected" });
        return;
      }

      if (req.method !== "GET") {
        if (req.url === "/healthz" || req.url === "/readyz") {
          writeJson(res, 405, { error: "method_not_allowed" }, { allow: "GET" });
          return;
        }
        writeJson(res, 404, { error: "not_found" });
        return;
      }

      if (req.url === "/healthz") {
        writeJson(res, 200, { status: "ok", service: "asset-exchange-api" });
        return;
      }

      if (req.url === "/readyz") {
        try {
          const result = await runWithTimeout(readinessProbe, readinessTimeoutMs);
          if (result?.ready === true) {
            writeJson(res, 200, { status: "ready", service: "asset-exchange-api" });
          } else {
            writeJson(res, 503, { status: "not_ready", service: "asset-exchange-api" });
          }
        } catch {
          writeJson(res, 503, { status: "not_ready", service: "asset-exchange-api" });
        }
        return;
      }

      writeJson(res, 404, { error: "not_found" });
    } catch {
      if (!res.headersSent) {
        writeJson(res, 500, { error: "internal_error" });
      } else {
        res.destroy();
      }
    }
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  server.on("clientError", (_err, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    } else {
      socket.destroy();
    }
  });

  return server;
}

export async function listenApiServer(server, config) {
  invariant(server && typeof server.listen === "function", "API_SERVER", "valid server required");
  invariant(config && typeof config === "object", "API_CONFIG", "config required");

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });

  return server.address();
}
