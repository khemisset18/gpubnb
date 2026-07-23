import type { WorkspaceManifest } from './workspace-manifests.js';

export type MachineCapabilities={ramTotalMiB:number|null;diskTotalMiB:number|null;vramMiB:number|null;cudaVersion:string|null;dockerAvailable:boolean;nvidiaRuntimeAvailable:boolean;operatingSystem:string|null;virtualizationAvailable:boolean};
export type CompatibilityResult={score:number;state:'READY'|'LIMITED'|'INSTALL_REQUIRED'|'INCOMPATIBLE';reasons:string[];missing:string[]};

export function analyzeWorkspace(machine:MachineCapabilities,manifest:WorkspaceManifest):CompatibilityResult{
 let score=100;const reasons:string[]=[];const missing:string[]=[];const min=manifest.minimum;const rec=manifest.recommended;
 const check=(actual:number|null,minimum:number,recommended:number,label:string)=>{if(actual===null){score-=20;missing.push(`${label} non mesuré`)}else if(actual<minimum){score-=45;missing.push(`${label}: ${actual} < ${minimum} MiB`)}else if(actual<recommended){score-=12;reasons.push(`${label} suffisant mais inférieur au niveau recommandé`)}else reasons.push(`${label} au niveau recommandé`)};
 check(machine.ramTotalMiB,min.ramMiB,rec.ramMiB,'RAM');check(machine.diskTotalMiB,min.diskMiB,rec.diskMiB,'Stockage');
 if(min.vramMiB)check(machine.vramMiB,min.vramMiB,rec.vramMiB??min.vramMiB,'VRAM');
 const flags:Array<[boolean|undefined,boolean,string]>=[[min.cuda,Boolean(machine.cudaVersion),'CUDA'],[min.docker,machine.dockerAvailable,'Docker'],[min.nvidiaRuntime,machine.nvidiaRuntimeAvailable,'NVIDIA Container Toolkit'],[min.virtualization,machine.virtualizationAvailable,'Virtualisation']];
 for(const [required,available,label] of flags)if(required&&!available){score-=30;missing.push(`${label} requis`)}else if(required)reasons.push(`${label} disponible`);
 score=Math.max(0,Math.min(100,score));const hardMissing=missing.some(item=>!item.includes('non mesuré'));
 const state=score<45||hardMissing&&score<70?'INCOMPATIBLE':missing.length?'INSTALL_REQUIRED':score<85?'LIMITED':'READY';
 return {score,state,reasons,missing};
}
