import assert from 'node:assert/strict';
import test from 'node:test';
import {findSerializableTransactions} from '../scripts/check-serializable-guard.mjs';

test('transaction guard ignores comments and strings without swallowing later calls',()=>{
  const source=`
    // db.$transaction(fn, {isolationLevel:'Serializable'});
    const example="db.$transaction(fn, {isolationLevel:'Serializable'})";
    db.$transaction(async tx=>{
      // Prisma's timeout bounds work (even with unmatched parentheses: (((
      /* Serializable isn't an isolation option here: ))) */
      return tx.session.findFirst();
    });
    db.$transaction(fn, {isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
  `;
  const findings=findSerializableTransactions(source);
  assert.equal(findings.length,1);
  assert.equal(findings[0].line,9);
});

test('transaction guard finds real nested/template calls and allows the retry wrapper',()=>{
  const source="runBookingTransaction(db, fn, {isolationLevel:'Serializable'});\n"
    +"const result = `${prisma.$transaction(fn, {isolationLevel:'Serializable'})}`;\n"
    +"tx.$transaction(fn, {isolationLevel:'ReadCommitted'});";
  assert.deepEqual(findSerializableTransactions(source).map(x=>x.line),[2]);
});
