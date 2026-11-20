import fs from "node:fs";
import assert from "node:assert/strict";
import { assessDogeObservations } from "../../../chain-watchers/src/dogecoin-observation.mjs";
import { tipEvidenceConsistency } from "../../../chain-watchers/src/evidence.mjs";
const [input,output]=process.argv.slice(2);
assert(input && output,"report and output paths required");
assert(fs.statSync(input).size<=2*1024*1024,"bounded report required");
const report=JSON.parse(fs.readFileSync(input,"utf8"));
assert.equal(report.experimentStatus,"PASS");assert.equal(report.qualificationStatus,"BLOCKED");
assert(["auxpowExpanded","fundingReorg","fundingUnconfirmed"].filter(key=>Object.hasOwn(report,key)).length<=1,
  "native evidence scopes must be mutually exclusive");
if(report.auxpowExpanded){
  assert.equal(report.manifest.labSuite,"auxpow-expanded");
  assert.equal(report.auxpowExpanded.previousEightControlsRepeated,false);
  assert.equal(report.auxpowExpanded.cases.length,12);
  assert(report.auxpowExpanded.cases.every(x=>x.status==="PASS"));
  const expected={"before-probes":"CONSISTENT","after-negative-probes":"CONSISTENT",
    "after-valid-boundaries":"CONSISTENT","partitioned-boundary-chain":"UNCERTAIN",
    "converged-boundary-reorg":"CONSISTENT"};
  const tipStages={};
  for(const stage of report.auxpowExpanded.tipStages){
    assert(Object.hasOwn(expected,stage.label)&&!Object.hasOwn(tipStages,stage.label));
    assert.equal(stage.observations.length,2);
    assert.deepEqual(stage.observations.map(x=>x.sourceId).sort(),["doge-a","doge-b"]);
    assert(stage.observations.every(x=>x.chainId==="dogecoin"&&x.networkId==="regtest"));
    const consistency=tipEvidenceConsistency(stage.observations);
    assert.equal(consistency,expected[stage.label]);
    tipStages[stage.label]={consistency,settlementAllowed:false,canAdvance:false};
  }
  assert.deepEqual(Object.keys(tipStages).sort(),Object.keys(expected).sort());
  fs.writeFileSync(output,JSON.stringify({historicalEvidenceReview:true,scope:"auxpow-chain-tips-only",
    qualificationStatus:"BLOCKED",settlementAllowed:false,tipStages},null,2)+"\n");
}else if(report.fundingUnconfirmed){
  assert.equal(report.manifest.labSuite,"recovery-funding-reorg");
  assert.deepEqual(report.manifest.selectedNativeCases,["unconfirmed-funding-refuses-rebroadcast"]);
  assert.equal(report.generatedBlocks,0);assert.deepEqual(report.stages,[]);
  const result=report.fundingUnconfirmed;
  for(const key of ["fundingTxid","refundTxid","refundSha256","retainedBundleSha256"]){
    assert.equal(typeof result[key],"string");assert.match(result[key],/^[0-9a-f]{64}$/);
  }
  assert.equal(result.keysCreated,0);assert.equal(result.transactionsSigned,0);
  assert.equal(result.oldFundingReorgCasesRepeated,false);
  assert.equal(result.newFundingGuardIsolatedNatively,true);
  assert.equal(result.activeBlocks,1355);assert.equal(result.activeHeaders,1355);
  assert.equal(result.fundingConfirmations,0);assert.equal(result.refundConfirmations,0);
  assert.equal(result.standaloneInvocations,2);assert.equal(result.generatedBlocks,0);
  assert.equal(result.refusalBroadcasts,0);
  assert.equal(result.standaloneRefusal,"funding is not confirmed on active chain; no broadcast");
  assert.deepEqual(result.cases.map(x=>[x.id,x.status]),[["unconfirmed-funding-refuses-rebroadcast","PASS"]]);
  const [observed,refused]=report.independentRecoveryCalls;
  assert.equal(report.independentRecoveryCalls.length,2);
  assert.equal(observed.state,"PENDING");assert.equal(observed.fundingConfirmed,false);
  assert.equal(observed.transition,"PENDING");
  assert.equal(observed.txid,result.refundTxid);
  assert.equal(refused.state,"UNKNOWN");assert.equal(refused.transition,"EXPECTED_REFUSAL");
  assert.equal(refused.expectedRefusal,result.standaloneRefusal);
  for(const call of report.independentRecoveryCalls){
    assert.equal(call.qualificationStatus,"BLOCKED");
    assert.equal(call.source,"a");assert.equal(call.labLabel,"funding-unconfirmed");
    assert(call.rpcCalls.length>0&&call.rpcCalls.length<=64);
    assert(call.rpcCalls.every(x=>x.method!=="sendrawtransaction"));
    assert.equal(call.isolationProof.backendUnavailable,true);
    assert.equal(call.isolationProof.originalSigningKeysUnavailable,true);
  }
  fs.writeFileSync(output,JSON.stringify({historicalEvidenceReview:true,scope:"unconfirmed-funding-guard-only",
    qualificationStatus:"BLOCKED",settlementAllowed:false,canAdvance:false,
    newFundingGuardIsolatedNatively:true,oldFundingReorgCasesRepeated:false},null,2)+"\n");
}else if(report.fundingReorg){
  assert.equal(report.manifest.labSuite,"recovery-funding-reorg");
  assert.equal(report.fundingReorg.keysCreated,0);
  assert.equal(report.fundingReorg.transactionsSigned,0);
  assert.equal(report.fundingReorg.previousNativeSuitesRepeated,false);
  assert.equal(report.fundingReorg.newFundingGuardIsolatedNatively,false);
  assert.deepEqual(report.fundingReorg.cases.map(x=>[x.id,x.status]),[
    ["pending-refund-after-funding-reorg","PASS"],["same-refund-after-funding-restoration","PASS"]]);
  const expected={"pending-confirmed-funding":"CONSISTENT","funding-rolled-back":"UNCERTAIN",
    "funding-restored":"CONSISTENT","refund-confirmed":"CONSISTENT"};
  const stages={};let previousBySource={};
  for(const stage of report.stages){
    assert(Object.hasOwn(expected,stage.label)&&!Object.hasOwn(stages,stage.label));
    assert.deepEqual(stage.observations.map(x=>x.sourceId).sort(),["doge-a","doge-b"]);
    const nowUnixMs=Math.max(...stage.observations.map(x=>x.observedAtUnixMs));
    const result=assessDogeObservations(stage.observations,{previousBySource,nowUnixMs});
    assert.equal(result.consistency,expected[stage.label]);assert.equal(result.canAdvance,false);
    assert.equal(result.settlementAllowed,false);stages[stage.label]=result;
    previousBySource=Object.fromEntries(stage.observations.map(x=>[x.sourceId,x]));
  }
  assert.deepEqual(Object.keys(stages).sort(),Object.keys(expected).sort());
  fs.writeFileSync(output,JSON.stringify({historicalEvidenceReview:true,scope:"funding-reorg-regression",
    qualificationStatus:"BLOCKED",settlementAllowed:false,stages},null,2)+"\n");
}else{
const stages={};let previousBySource={};
for(const stage of report.stages){
  assert(!stages[stage.label],"duplicate stage");
  // Review historical paired snapshots at their captured time, never present them as live observations.
  const nowUnixMs=Math.max(...stage.observations.map(x=>x.observedAtUnixMs));
  const result=assessDogeObservations(stage.observations,{previousBySource,nowUnixMs});
  stages[stage.label]=result;
  previousBySource=Object.fromEntries(stage.observations.map(x=>[x.sourceId,x]));
}
assert.equal(stages.partitioned_claim.consistency,"UNCERTAIN");assert.equal(stages.partitioned_claim.canAdvance,false);
assert.equal(stages.reorged_claim.consistency,"CONFLICT");assert.equal(stages.reorged_claim.canAdvance,false);
assert.equal(stages.reorged_claim.states["doge-a"],"CONFLICTED");
assert.equal(stages.converged_refund.consistency,"CONSISTENT");assert.equal(stages.converged_refund.canAdvance,true);
assert.equal(stages.recovery_refund_confirmed.consistency,"CONSISTENT");
assert.equal(stages.recovery_refund_confirmed.canAdvance,false);
fs.writeFileSync(output,JSON.stringify({historicalEvidenceReview:true,qualificationStatus:"BLOCKED",settlementAllowed:false,stages},null,2)+"\n");
}
