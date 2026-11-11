import fs from "node:fs";
import assert from "node:assert/strict";
import { assessDogeObservations } from "../../../chain-watchers/src/dogecoin-observation.mjs";
const [input,output]=process.argv.slice(2);
assert(input && output,"report and output paths required");
assert(fs.statSync(input).size<=2*1024*1024,"bounded report required");
const report=JSON.parse(fs.readFileSync(input,"utf8"));
assert.equal(report.experimentStatus,"PASS");assert.equal(report.qualificationStatus,"BLOCKED");
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
