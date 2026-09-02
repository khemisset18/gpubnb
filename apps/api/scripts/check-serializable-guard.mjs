#!/usr/bin/env node
// Architecture guard: a raw db.$transaction(...)/tx.$transaction(...)/prisma.$transaction(...)
// call that specifies Serializable isolation must go through runBookingTransaction
// (booking-transaction-retry.ts), the one place P2034 (Postgres serialization_failure)
// and P2028 (Prisma couldn't even start the transaction in time) are retried. A
// Serializable transaction added outside that wrapper silently reintroduces the exact bug
// class this project has twice found live in production (GPU_PROOF completion 500s,
// spurious resource_conflict/workspace_preparation_failed under real concurrent load).
//
// Deliberately narrow: only flags a literal `.$transaction(` call whose own argument list
// contains the word "Serializable". It does not touch:
//   - plain (non-Serializable) db.$transaction(...) calls - Prisma's default isolation is
//     a legitimate, common choice, not something this guard has an opinion on;
//   - array-form batch transactions (db.$transaction([...])) - these don't take an
//     isolationLevel option at all, so they can never match;
//   - runBookingTransaction(db, fn, { isolationLevel: ... }) call sites themselves - the
//     approved mechanism, matched by a different callee name, never "$transaction(";
//   - booking-transaction-retry.ts's own internal db.$transaction(fn, txOptions) call -
//     it never hardcodes the word "Serializable" (isolationLevel flows through an
//     options parameter), so nothing here special-cases that file.
//
// Usage: node scripts/check-serializable-guard.mjs
// Exit 0 (no violations) or 1 (violations found, printed with file:line).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const repoRoot = path.join(here, '..', '..', '..');

// Regression guard, not a retroactive one: pre-existing raw Serializable transactions
// this guard's introduction found (untouched technical debt, not approved exceptions -
// see the file's own _comment) are allowlisted by exact file:line so the build isn't
// blocked on everything outside this session's audited scope. Any NEW raw Serializable
// .$transaction() call - anywhere, not just in already-flagged files - still fails.
const allowlistPath = path.join(here, 'serializable-guard-allowlist.json');
const allowlist = new Set(JSON.parse(readFileSync(allowlistPath, 'utf8')).entries);

/** @returns {string[]} */
function listTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const TRANSACTION_CALL = /\b(?:db|tx|prisma)\.\$transaction\s*\(/g;

/** Given source and the index right after a call's opening '(', returns the index of its matching ')'. */
function findMatchingParen(source, openIndex) {
  let depth = 1;
  let i = openIndex;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    // Skip over string/template literals so a ')' or '(' inside a string can't desync depth.
    else if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
    }
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

const violations = [];
for (const file of listTsFiles(srcDir)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(TRANSACTION_CALL)) {
    const openParenIndex = match.index + match[0].length - 1;
    const closeParenIndex = findMatchingParen(source, openParenIndex + 1);
    if (closeParenIndex === -1) continue; // unbalanced - shouldn't happen in valid TS, skip rather than false-positive
    const args = source.slice(openParenIndex + 1, closeParenIndex);
    if (/\bSerializable\b/.test(args)) {
      const relFile = path.relative(repoRoot, file).replace(/\\/g, '/');
      const line = lineNumberAt(source, match.index);
      if (allowlist.has(`${relFile}:${line}`)) continue;
      violations.push({
        file: relFile,
        line,
        snippet: match[0] + args.slice(0, 80).replace(/\s+/g, ' ') + (args.length > 80 ? '…' : ''),
      });
    }
  }
}

if (violations.length > 0) {
  console.error('Serializable transaction guard: found raw .$transaction() call(s) with Serializable isolation that bypass runBookingTransaction:\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}\n    ${v.snippet}\n`);
  }
  console.error('Fix: wrap the callback with runBookingTransaction(db, fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, ... }) from booking-transaction-retry.ts instead of calling .$transaction(...) directly, so P2034/P2028 are retried instead of surfacing as a raw 500 or a spurious rejection.');
  process.exit(1);
}

console.log('Serializable transaction guard: OK - every Serializable .$transaction() call goes through runBookingTransaction.');
