#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { encryptRecoveryPayload, decryptRecoveryEnvelope } from "./bundle.mjs";
import { invariant } from "../../core/src/errors.mjs";
import { parseStrictJson } from "./strict-json.mjs";

function readTextFile(path, maxBytes, code) {
  const st = statSync(path);
  invariant(st.isFile() && st.size >= 1 && st.size <= maxBytes, code, "invalid input file size/type");
  return readFileSync(path, "utf8");
}

function readKey(path) {
  const st = statSync(path);
  if (process.platform !== "win32") invariant((st.mode & 0o077) === 0, "RECOVERY_CLI_KEY_PERMISSIONS", "recovery key file must not be group/world accessible");
  const encoded = readTextFile(path, 128, "RECOVERY_CLI_KEY").trim();
  invariant(/^[A-Za-z0-9_-]{43}$/.test(encoded), "RECOVERY_CLI_KEY", "invalid recovery key file");
  const key = Buffer.from(encoded, "base64url");
  invariant(key.length === 32, "RECOVERY_CLI_KEY", "recovery key must be 32 bytes");
  return key;
}

function writeExclusive(path, content) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, content, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function usage() {
  console.error("usage: cli.mjs keygen <keyfile> | encrypt <keyfile> <payload.json> <bundle.json> | decrypt <keyfile> <bundle.json> <payload.json>");
  process.exitCode = 2;
}

const [, , command, ...args] = process.argv;

if (command === "keygen" && args.length === 1) {
  const key = randomBytes(32);
  try {
    writeExclusive(args[0], key.toString("base64url") + "\n");
    console.log("recovery key created");
  } finally {
    key.fill(0);
  }
} else if (command === "encrypt" && args.length === 3) {
  const key = readKey(args[0]);
  try {
    const payload = parseStrictJson(readTextFile(args[1], 12 * 1024 * 1024, "RECOVERY_CLI_PAYLOAD"));
    const envelope = encryptRecoveryPayload(payload, key);
    writeExclusive(args[2], JSON.stringify(envelope) + "\n");
    console.log("recovery bundle encrypted");
  } finally {
    key.fill(0);
  }
} else if (command === "decrypt" && args.length === 3) {
  const key = readKey(args[0]);
  try {
    const envelope = parseStrictJson(readTextFile(args[1], 12 * 1024 * 1024, "RECOVERY_CLI_BUNDLE"));
    const payload = decryptRecoveryEnvelope(envelope, key);
    writeExclusive(args[2], JSON.stringify(payload) + "\n");
    console.log("recovery bundle decrypted");
  } finally {
    key.fill(0);
  }
} else {
  usage();
}
