import type { WorkspaceCategory } from './workspace-manifests.js';

export type WorkspaceRuntimeKind = 'CONTAINER'|'DESKTOP_VM'|'ISOLATED_VM'|'STREAMING_VM';
export type WorkspaceSurface = 'BATCH'|'CODE'|'NOTEBOOK'|'DESKTOP'|'API'|'STREAM';

export type WorkspaceRuntimeProfile = {
  slug:string;
  runtime:WorkspaceRuntimeKind;
  surface:WorkspaceSurface;
  category:WorkspaceCategory;
  entrypoint:string;
  network:'NONE'|'EGRESS_POLICY'|'GATEWAY_ONLY';
  persistentWorkspace:boolean;
  hostAccess:false;
  dockerSocket:false;
  privileged:false;
};

/**
 * Product workspaces are profiles over one lifecycle engine. They MUST NOT
 * become thirteen independent remote-access implementations.
 *
 * Runtime images/VM templates are intentionally not embedded here until they
 * are pinned by digest and verified in CI. A catalog card is never proof that
 * an executable runtime exists.
 */
export const workspaceRuntimeProfiles:Readonly<Record<string,WorkspaceRuntimeProfile>>=Object.freeze({
  compute:{slug:'compute',runtime:'CONTAINER',surface:'BATCH',category:'COMPUTE',entrypoint:'job',network:'NONE',persistentWorkspace:false,hostAccess:false,dockerSocket:false,privileged:false},
  developer:{slug:'developer',runtime:'CONTAINER',surface:'CODE',category:'DEVELOPMENT',entrypoint:'code-server',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  ai:{slug:'ai',runtime:'CONTAINER',surface:'NOTEBOOK',category:'AI',entrypoint:'jupyterlab',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  api:{slug:'api',runtime:'CONTAINER',surface:'API',category:'API',entrypoint:'gateway',network:'GATEWAY_ONLY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  data:{slug:'data',runtime:'CONTAINER',surface:'NOTEBOOK',category:'DATA',entrypoint:'jupyterlab',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  'cloud-desktop':{slug:'cloud-desktop',runtime:'DESKTOP_VM',surface:'DESKTOP',category:'DESKTOP',entrypoint:'desktop-gateway',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  creator:{slug:'creator',runtime:'DESKTOP_VM',surface:'DESKTOP',category:'CREATION',entrypoint:'desktop-gateway',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  // Delivered as CONTAINER/NOTEBOOK (JupyterLab + real GPU-accelerated FFmpeg/
  // NVENC), not the DESKTOP_VM this originally assumed: no VM/hypervisor
  // infrastructure exists in this codebase, and no official DaVinci Resolve
  // or GPU-accelerated Blender-desktop container was viable to build without
  // publishing a custom image (see docs/SESSION_RESUME.md). This profile is
  // corrected to match what's actually real, not what was first envisioned.
  video:{slug:'video',runtime:'CONTAINER',surface:'NOTEBOOK',category:'VIDEO',entrypoint:'jupyterlab',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  cad:{slug:'cad',runtime:'DESKTOP_VM',surface:'DESKTOP',category:'CAD',entrypoint:'desktop-gateway',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  mobile:{slug:'mobile',runtime:'ISOLATED_VM',surface:'DESKTOP',category:'MOBILE',entrypoint:'desktop-gateway',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  'security-lab':{slug:'security-lab',runtime:'ISOLATED_VM',surface:'DESKTOP',category:'SECURITY',entrypoint:'isolated-lab-gateway',network:'NONE',persistentWorkspace:false,hostAccess:false,dockerSocket:false,privileged:false},
  gaming:{slug:'gaming',runtime:'STREAMING_VM',surface:'STREAM',category:'GAMING',entrypoint:'stream-gateway',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  audio:{slug:'audio',runtime:'STREAMING_VM',surface:'STREAM',category:'AUDIO',entrypoint:'stream-gateway',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
});

export function workspaceRuntimeProfile(slug:string){return workspaceRuntimeProfiles[slug];}
