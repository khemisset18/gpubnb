import { invariant } from "../../core/src/errors.mjs";

export async function readBody(req, { maxBytes = 64 * 1024 } = {}) {
  invariant(Number.isSafeInteger(maxBytes) && maxBytes >= 1 && maxBytes <= 1024 * 1024, "BODY_LIMIT_CONFIG", "invalid body limit");
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    invariant(total <= maxBytes, "BODY_TOO_LARGE", "request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function skipWs(text, state) {
  while (state.i < text.length && /\s/.test(text[state.i])) state.i++;
}

function parseStringToken(text, state) {
  invariant(text[state.i] === '"', "JSON_SYNTAX", "string expected");
  const start = state.i++;
  let escaped = false;
  while (state.i < text.length) {
    const ch = text[state.i++];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') {
      const raw = text.slice(start, state.i);
      try { return JSON.parse(raw); } catch { invariant(false, "JSON_SYNTAX", "invalid JSON string"); }
    }
    invariant(ch >= " ", "JSON_SYNTAX", "control character in JSON string");
  }
  invariant(false, "JSON_SYNTAX", "unterminated JSON string");
}

function parseValue(text, state) {
  skipWs(text, state);
  const ch = text[state.i];
  if (ch === "{") return parseObject(text, state);
  if (ch === "[") return parseArray(text, state);
  if (ch === '"') { parseStringToken(text, state); return; }

  const rest = text.slice(state.i);
  const match = rest.match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
  invariant(match, "JSON_SYNTAX", "invalid JSON value");
  state.i += match[0].length;
}

function parseArray(text, state) {
  state.i++;
  skipWs(text, state);
  if (text[state.i] === "]") { state.i++; return; }
  while (state.i < text.length) {
    parseValue(text, state);
    skipWs(text, state);
    if (text[state.i] === "]") { state.i++; return; }
    invariant(text[state.i] === ",", "JSON_SYNTAX", "comma expected");
    state.i++;
  }
  invariant(false, "JSON_SYNTAX", "unterminated array");
}

function parseObject(text, state) {
  state.i++;
  const keys = new Set();
  skipWs(text, state);
  if (text[state.i] === "}") { state.i++; return; }
  while (state.i < text.length) {
    skipWs(text, state);
    const key = parseStringToken(text, state);
    invariant(!keys.has(key), "JSON_DUPLICATE_KEY", "duplicate JSON object key");
    keys.add(key);
    skipWs(text, state);
    invariant(text[state.i] === ":", "JSON_SYNTAX", "colon expected");
    state.i++;
    parseValue(text, state);
    skipWs(text, state);
    if (text[state.i] === "}") { state.i++; return; }
    invariant(text[state.i] === ",", "JSON_SYNTAX", "comma expected");
    state.i++;
  }
  invariant(false, "JSON_SYNTAX", "unterminated object");
}

export function parseStrictJson(text) {
  invariant(typeof text === "string", "JSON_TYPE", "JSON body must be text");
  invariant(text.length > 0, "JSON_EMPTY", "JSON body required");
  const state = { i: 0 };
  parseValue(text, state);
  skipWs(text, state);
  invariant(state.i === text.length, "JSON_TRAILING", "trailing JSON data");
  try {
    return JSON.parse(text);
  } catch {
    invariant(false, "JSON_SYNTAX", "invalid JSON");
  }
}

export async function readStrictJson(req, options) {
  const type = req.headers["content-type"];
  invariant(typeof type === "string" && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type), "CONTENT_TYPE", "application/json required");
  return parseStrictJson(await readBody(req, options));
}
