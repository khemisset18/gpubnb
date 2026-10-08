import { invariant } from "../../core/src/errors.mjs";

function skipWs(text, state) {
  while (state.i < text.length && /[ \t\r\n]/.test(text[state.i])) state.i += 1;
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
      try { return JSON.parse(raw); }
      catch { invariant(false, "JSON_SYNTAX", "invalid JSON string"); }
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
  state.i += 1;
  skipWs(text, state);
  if (text[state.i] === "]") { state.i += 1; return; }
  while (state.i < text.length) {
    parseValue(text, state);
    skipWs(text, state);
    if (text[state.i] === "]") { state.i += 1; return; }
    invariant(text[state.i] === ",", "JSON_SYNTAX", "comma expected");
    state.i += 1;
  }
  invariant(false, "JSON_SYNTAX", "unterminated array");
}

function parseObject(text, state) {
  state.i += 1;
  const keys = new Set();
  skipWs(text, state);
  if (text[state.i] === "}") { state.i += 1; return; }
  while (state.i < text.length) {
    skipWs(text, state);
    const key = parseStringToken(text, state);
    invariant(!keys.has(key), "JSON_DUPLICATE_KEY", "duplicate JSON object key");
    keys.add(key);
    skipWs(text, state);
    invariant(text[state.i] === ":", "JSON_SYNTAX", "colon expected");
    state.i += 1;
    parseValue(text, state);
    skipWs(text, state);
    if (text[state.i] === "}") { state.i += 1; return; }
    invariant(text[state.i] === ",", "JSON_SYNTAX", "comma expected");
    state.i += 1;
  }
  invariant(false, "JSON_SYNTAX", "unterminated object");
}

export function parseStrictJson(text) {
  invariant(typeof text === "string", "JSON_TYPE", "JSON input must be text");
  invariant(text.length > 0, "JSON_EMPTY", "JSON input required");
  const state = { i: 0 };
  parseValue(text, state);
  skipWs(text, state);
  invariant(state.i === text.length, "JSON_TRAILING", "trailing JSON data");
  try { return JSON.parse(text); }
  catch { invariant(false, "JSON_SYNTAX", "invalid JSON"); }
}
