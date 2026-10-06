import { DomainError, invariant } from "../../core/src/errors.mjs";
import { validateIdempotencyKey } from "./authz.mjs";
import { readStrictJson } from "./strict-json.mjs";

function errorResponse(error) {
  if (!(error instanceof DomainError)) return { statusCode: 500, body: { error: "internal_error" } };

  if (["AUTH_REQUIRED", "SESSION_EXPIRED"].includes(error.code)) return { statusCode: 401, body: { error: "authentication_required" } };
  if (["CSRF_REQUIRED", "CSRF_INVALID", "OBJECT_AUTHZ", "ORIGIN_FORBIDDEN", "FETCH_SITE_FORBIDDEN"].includes(error.code)) return { statusCode: 403, body: { error: "forbidden" } };
  if (["OFFER_NOT_OPEN", "STALE_EPOCH", "DEPLOYMENT_MISMATCH"].includes(error.code)) return { statusCode: 409, body: { error: "conflict" } };
  if (error.code.startsWith("RATE_")) return { statusCode: 429, body: { error: "rate_limited" } };
  if (error.code === "BODY_TOO_LARGE") return { statusCode: 413, body: { error: "payload_too_large" } };
  return { statusCode: 400, body: { error: "invalid_request" } };
}

function signatureFromBody(body) {
  invariant(body && typeof body === "object" && !Array.isArray(body), "BODY_OBJECT", "object body required");
  invariant(typeof body.signature === "string" && body.signature.length >= 1 && body.signature.length <= 8192, "SIGNATURE_HTTP", "signature required");
  return body.signature;
}

export function createBusinessRouter({
  sessionManager,
  offerService,
  rateLimiter,
  allowedOrigins,
  maxBodyBytes = 64 * 1024
}) {
  invariant(sessionManager && typeof sessionManager.authenticateRequest === "function" && typeof sessionManager.assertCsrf === "function" && typeof sessionManager.revokeRequest === "function", "ROUTER_SESSION", "session manager required");
  invariant(offerService && typeof offerService.publishOffer === "function", "ROUTER_OFFER_SERVICE", "offer service required");
  invariant(rateLimiter && typeof rateLimiter.consume === "function", "ROUTER_RATE_LIMIT", "rate limiter required");
  invariant(Array.isArray(allowedOrigins) && allowedOrigins.length > 0, "ROUTER_ORIGINS", "allowed origins required");
  const originSet = new Set(allowedOrigins);
  invariant(originSet.size === allowedOrigins.length, "ROUTER_ORIGIN_DUPLICATE", "duplicate allowed origin");
  for (const origin of originSet) {
    invariant(typeof origin === "string" && /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(origin), "ROUTER_ORIGIN_FORMAT", "allowed origins must be explicit https origins");
  }

  return async function route(req, sendJson) {
    const pathname = new URL(req.url, "http://asset-exchange.invalid").pathname;
    const logout = req.method === "POST" && pathname === "/v1/session/logout";
    const publish = req.method === "POST" && pathname === "/v1/offers";
    const cancelMatch = req.method === "POST" && pathname.match(/^\/v1\/offers\/([^/]+)\/cancel$/);
    const acceptMatch = req.method === "POST" && pathname.match(/^\/v1\/offers\/([^/]+)\/accept$/);

    if (!logout && !publish && !cancelMatch && !acceptMatch) return false;

    try {
      const actor = await sessionManager.authenticateRequest(req);
      const origin = req.headers.origin;
      invariant(typeof origin === "string" && originSet.has(origin), "ORIGIN_FORBIDDEN", "request origin not allowed");
      const fetchSite = req.headers["sec-fetch-site"];
      invariant(fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "same-site", "FETCH_SITE_FORBIDDEN", "cross-site browser request forbidden");
      await sessionManager.assertCsrf(req, actor);

      const routeClass = logout ? "logout" : publish ? "publish" : cancelMatch ? "cancel" : "accept";
      const rate = await rateLimiter.consume(`${actor.subject}:${routeClass}`);
      if (!rate.allowed) {
        sendJson(429, { error: "rate_limited" }, { "retry-after": "60" });
        return true;
      }

      if (logout) {
        await sessionManager.revokeRequest(req);
        sendJson(200, { status: "logged_out" }, {
          "set-cookie": "__Host-gpubnb-ae-session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0"
        });
        return true;
      }

      const rawIdempotency = req.headers["idempotency-key"];
      const idempotencyKey = validateIdempotencyKey(rawIdempotency);

      if (publish) {
        const body = await readStrictJson(req, { maxBytes: maxBodyBytes });
        const result = await offerService.publishOffer({
          actor,
          offer: body.offer,
          signature: signatureFromBody(body),
          idempotencyKey
        });
        sendJson(201, result);
        return true;
      }

      if (cancelMatch) {
        invariant(req.headers["content-length"] === undefined || req.headers["content-length"] === "0", "CANCEL_BODY", "cancel request must not include a body");
        const offerId = decodeURIComponent(cancelMatch[1]);
        const result = await offerService.cancelOffer({ actor, offerId, idempotencyKey });
        sendJson(200, result);
        return true;
      }

      const body = await readStrictJson(req, { maxBytes: maxBodyBytes });
      const offerId = decodeURIComponent(acceptMatch[1]);
      invariant(body.acceptance?.offerId === offerId, "ACCEPT_PATH_MISMATCH", "path/body offer mismatch");
      const result = await offerService.acceptOffer({
        actor,
        acceptance: body.acceptance,
        signature: signatureFromBody(body),
        idempotencyKey
      });
      sendJson(200, result);
      return true;
    } catch (error) {
      const mapped = errorResponse(error);
      sendJson(mapped.statusCode, mapped.body);
      return true;
    }
  };
}
