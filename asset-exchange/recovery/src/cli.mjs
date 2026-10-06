#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { encryptRecoveryPayload, decryptRecoveryEnvelope } from "./bundle.mjs";
import { invariant } from "../../core/src/errors.mjs";

function readKey(path) {
  const encoded = readFileSync(path, "utf8").trim();
  invariant(/^[A-Za-z0-9_-]{43}$/.test(encoded), "RECOVERY_CLI_KEY", "invalid recovery key file");
  const key = Buffer.from(encoded, "base64url");
  invariant(key.length === 32, "RECOVERY_CLI_KEY", "recovery key must be 32 bytes");
  return key;
}

function writeExclusive(path, content) {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
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
    const payload = JSON.parse(readFileSync(args[1], "utf8"));
    const envelope = encryptRecoveryPayload(payload, key);
    writeExclusive(args[2], JSON.stringify(envelope) + "\n");
    console.log("recovery bundle encrypted");
  } finally {
    key.fill(0);
  }
} else if (command === "decrypt" && args.length === 3) {
  const key = readKey(args[0]);
  try {
    const envelope = JSON.parse(readFileSync(args[1], "utf8"));
    const payload = decryptRecoveryEnvelope(envelope, key);
    writeExclusive(args[2], JSON.stringify(payload) + "\n");
    console.log("recovery bundle decrypted");
  } finally {
    key.fill(0);
  }
} else {
  usage();
}
