import { DomainError, invariant } from "../../core/src/errors.mjs";
import { listAssetCatalog, getAssetCatalogRecord } from "../../core/src/asset-registry.mjs";
import { validateIdempotencyKey } from "./authz.mjs";
import { readStrictJson } from "./strict-json.mjs";

function errorResponse(error) {
  if (!(error instanceof DomainError)) return { statusCode: 500, body: { error: "internal_error" } };

  if (["AUTH_REQUIRED", "SESSION_EXPIRED", "SSO_SIGNATURE_INVALID", "SSO_REPLAY", "SSO_EXPIRED", "SSO_ISSUER_MISMATCH", "SSO_AUDIENCE_MISMATCH", "SSO_DEPLOYMENT_MISMATCH"].includes(error.code)) return { statusCode: 401, body: { error: "authentication_required" } };
  if (["CSRF_REQUIRED", "CSRF_INVALID", "OBJECT_AUTHZ", "ORIGIN_FORBIDDEN", "FETCH_SITE_FORBIDDEN", "ADMIN_NOT_AUTHORIZED", "ADMIN_ASSERTION_INVALID", "ADMIN_USER_VERIFICATION"].includes(error.code)) return { statusCode: 403, body: { error: "forbidden" } };
  if (["OFFER_NOT_OPEN", "STALE_EPOCH", "DEPLOYMENT_MISMATCH", "ADMIN_CHALLENGE_REPLAY", "ADMIN_CHALLENGE_EXPIRED", "ADMIN_TRANSITION_BLOCKED", "ADMIN_DEPLOYMENT_MISMATCH"].includes(error.code)) return { statusCode: 409, body: { error: "conflict" } };
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
  ssoService = null,
  adminFeeService = null,
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
    const exchangeSession = req.method === "POST" && pathname === "/v1/session/exchange";
    const logout = req.method === "POST" && pathname === "/v1/session/logout";
    const adminFeeChallenge = req.method === "POST" && pathname === "/v1/admin/fee-policy/challenge";
    const adminFeeActivate = req.method === "POST" && pathname === "/v1/admin/fee-policy/activate";
    const assetList = req.method === "GET" && pathname === "/v1/assets";
    const assetDetailMatch = req.method === "GET" && pathname.match(/^\/v1\/assets\/([a-z0-9][a-z0-9._:-]{2,127})$/);
    const publish = req.method === "POST" && pathname === "/v1/offers";
    const cancelMatch = req.method === "POST" && pathname.match(/^\/v1\/offers\/([^/]+)\/cancel$/);
    const acceptMatch = req.method === "POST" && pathname.match(/^\/v1\/offers\/([^/]+)\/accept$/);

    if (!exchangeSession && !logout && !adminFeeChallenge && !adminFeeActivate && !assetList && !assetDetailMatch && !publish && !cancelMatch && !acceptMatch) return false;

    try {
      const origin = req.headers.origin;
      invariant(typeof origin === "string" && originSet.has(origin), "ORIGIN_FORBIDDEN", "request origin not allowed");
      const fetchSite = req.headers["sec-fetch-site"];
      invariant(fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "same-site", "FETCH_SITE_FORBIDDEN", "cross-site browser request forbidden");

      if (exchangeSession) {
        invariant(ssoService && typeof ssoService.exchange === "function", "SSO_DISABLED", "SSO exchange is disabled");
        const remote = req.socket?.remoteAddress ?? "unknown";
        const rate = await rateLimiter.consume(`sso:${remote}`);
        if (!rate.allowed) {
          sendJson(429, { error: "rate_limited" }, { "retry-after": "60" });
          return true;
        }
        const body = await readStrictJson(req, { maxBytes: maxBodyBytes });
        const issued = await ssoService.exchange({ ticket: body.ticket, signature: body.signature });
        sendJson(200, { status: "session_created", csrfToken: issued.csrfToken, expiresAtUnixMs: issued.expiresAtUnixMs }, {
          "set-cookie": issued.cookie
        });
        return true;
      }

      const actor = await sessionManager.authenticateRequest(req);
      if (req.method !== "GET") await sessionManager.assertCsrf(req, actor);

      const routeClass = assetList ? "assets-list" : assetDetailMatch ? "assets-detail" : logout ? "logout" : adminFeeChallenge ? "admin-fee-challenge" : adminFeeActivate ? "admin-fee-activate" : publish ? "publish" : cancelMatch ? "cancel" : "accept";
      const rate = await rateLimiter.consume(`${actor.subject}:${routeClass}`);
      if (!rate.allowed) {
        sendJson(429, { error: "rate_limited" }, { "retry-after": "60" });
        return true;
      }

      if (assetList) {
        sendJson(200, { assets: listAssetCatalog() });
        return true;
      }

      if (assetDetailMatch) {
        const record = getAssetCatalogRecord(assetDetailMatch[1]);
        if (record === null) {
          sendJson(404, { error: "asset_not_found" });
          return true;
        }
        sendJson(200, { asset: record });
        return true;
      }

      if (logout) {
        await sessionManager.revokeRequest(req);
        sendJson(200, { status: "logged_out" }, {
          "set-cookie": "__Host-gpubnb-ae-session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0"
        });
        return true;
      }

      if (adminFeeChallenge) {
        invariant(adminFeeService && typeof adminFeeService.createFeeChallenge === "function", "ADMIN_DISABLED", "admin fee service disabled");
        const body = await readStrictJson(req, { maxBytes: maxBodyBytes });
        const result = await adminFeeService.createFeeChallenge({
          actorSubject: actor.subject,
          proposedPolicy: body.policy
        });
        sendJson(200, result);
        return true;
      }

      if (adminFeeActivate) {
        invariant(adminFeeService && typeof adminFeeService.activateFeePolicy === "function", "ADMIN_DISABLED", "admin fee service disabled");
        const body = await readStrictJson(req, { maxBytes: maxBodyBytes });
        invariant(body.intent?.actorSubject === actor.subject, "OBJECT_AUTHZ", "admin intent/session subject mismatch");
        const result = await adminFeeService.activateFeePolicy({
          intent: body.intent,
          assertion: body.assertion
        });
        sendJson(200, result);
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
        const body = await readStrictJson(req, { maxBytes: maxBodyBytes });
        const offerId = decodeURIComponent(cancelMatch[1]);
        invariant(body.cancellation?.offerId === offerId, "CANCEL_PATH_MISMATCH", "path/body offer mismatch");
        const result = await offerService.cancelOffer({
          actor,
          cancellation: body.cancellation,
          signature: signatureFromBody(body),
          idempotencyKey
        });
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
