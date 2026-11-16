import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyWindowsAgentProcessProof } from '../src/windows-agent-process-proof.js';
const now=Date.parse('2026-11-02T12:00:00Z');
const proof={schemaVersion:1,machineId:'machine-a',challenge:'unique-challenge-0001',pid:123,
  startedAt:'2026-11-02T11:59:00Z',measuredAt:'2026-11-02T12:00:00Z',version:'0.6.6',
  commit:'a'.repeat(40),sha256:'b'.repeat(64),signatureStatus:'Valid',signerThumbprint:'c'.repeat(40)};
const pin={version:proof.version,commit:proof.commit,sha256:proof.sha256,signerThumbprint:proof.signerThumbprint,startedAfter:'2026-11-02T11:58:00Z'};
const context={machineId:proof.machineId,challenge:proof.challenge,approvedCommit:proof.commit,nowMs:now,pinsJson:JSON.stringify({'machine-a':pin})};
test('fresh signed-body process claim matches separately pinned release and machine',()=>{assert.equal(verifyWindowsAgentProcessProof(proof,context),true);});
for(const [label,changes] of Object.entries({
  oldProcess:{startedAt:'2026-11-01T12:00:00Z'},wrongCommit:{commit:'d'.repeat(40)},shortCommit:{commit:'aaaaaaa'},
  replayedChallenge:{challenge:'old-challenge-00000'},wrongMachine:{machineId:'machine-b'},wrongVersion:{version:'0.1'},
  replacedExecutable:{sha256:'e'.repeat(64)},unsigned:{signatureStatus:'NotSigned'},wrongSigner:{signerThumbprint:'f'.repeat(40)},
  staleMeasurement:{measuredAt:'2026-11-02T11:58:00Z'},futureProcess:{startedAt:'2026-11-03T00:00:00Z'},
}))test(`process claim rejects ${label}`,()=>{assert.equal(verifyWindowsAgentProcessProof({...proof,...changes},context),false);});
test('missing, malformed or foreign machine pins fail closed',()=>{
  for(const pinsJson of ['{}','null','[]','invalid',JSON.stringify({'machine-b':pin})])assert.equal(verifyWindowsAgentProcessProof(proof,{...context,pinsJson}),false);
});
test('another fresh challenge cannot consume the previous process claim',()=>{assert.equal(verifyWindowsAgentProcessProof(proof,{...context,challenge:'unique-challenge-0002'}),false);});
