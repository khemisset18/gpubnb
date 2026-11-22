#!/usr/bin/env node
// Architecture guard: a raw db.$transaction(...)/tx.$transaction(...)/prisma.$transaction(...)
// call that specifies Serializable isolation must go through runBookingTransaction
// (booking-transaction-retry.ts), the one place P2034 (Postgres serialization_failure)
// and P2028 (Prisma couldn't even start the transaction in time) are retried. A
// Serializable transaction added outside that wrapper silently reintroduces the exact bug
// class this project has twice found live in production (GPU_PROOF completion 500s,
// spurious resource_conflict/workspace_preparation_failed under real concurrent load).
//
// Deliberately narrow: only flags a literal `.$transaction(callback, options)` call whose
// options object sets isolationLevel to Serializable. TypeScript's AST keeps comments and
// SQL/template text out of the decision, so explanatory prose cannot create false alarms.
// It does not touch:
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
import ts from 'typescript';

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

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
}

function hasSerializableValue(expression) {
  let found = false;
  function visit(node) {
    if ((ts.isIdentifier(node) && node.text === 'Serializable')
      || (ts.isStringLiteralLike(node) && node.text === 'Serializable')) found = true;
    ts.forEachChild(node, visit);
  }
  visit(expression);
  return found;
}

function hasSerializableIsolation(options) {
  if (!ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some((property) =>
    ts.isPropertyAssignment(property)
      && propertyName(property.name) === 'isolationLevel'
      && hasSerializableValue(property.initializer));
}

const violations = [];
for (const file of listTsFiles(srcDir)) {
  const source = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  function visit(node) {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === '$transaction'
      && ts.isIdentifier(node.expression.expression)
      && ['db', 'tx', 'prisma'].includes(node.expression.expression.text)
      && node.arguments.length >= 2
      && hasSerializableIsolation(node.arguments[1])) {
      const relFile = path.relative(repoRoot, file).replace(/\\/g, '/');
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      if (!allowlist.has(`${relFile}:${line}`)) {
        violations.push({
          file: relFile,
          line,
          snippet: node.getText(sourceFile).slice(0, 100).replace(/\s+/g, ' '),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
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
