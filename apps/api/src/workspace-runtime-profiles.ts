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
  // Real entrypoint: the official jupyter/docker-stacks image launched
  // headless (jupyter_server with every notebook/lab UI extension disabled),
  // exposing only its REST + WebSocket kernel API - see workspace-manifests.ts
  // and docs/SESSION_RESUME.md.
  api:{slug:'api',runtime:'CONTAINER',surface:'API',category:'API',entrypoint:'jupyter-server-api',network:'GATEWAY_ONLY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  data:{slug:'data',runtime:'CONTAINER',surface:'NOTEBOOK',category:'DATA',entrypoint:'jupyterlab',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  // Planned architecture, NOT built/tested yet - no Linux GPU host available
  // (see docs/SESSION_RESUME.md section 8). CONTAINER, not DESKTOP_VM: no
  // VM/hypervisor infrastructure exists in this codebase, and the planned
  // real architecture (Selkies-GStreamer in a container, GPU passed through
  // via --gpus like every other GPU-attached workspace here) needs none.
  // entrypoint corrected from the fictional 'desktop-gateway' to what would
  // actually run.
  'cloud-desktop':{slug:'cloud-desktop',runtime:'CONTAINER',surface:'DESKTOP',category:'DESKTOP',entrypoint:'selkies-gstreamer',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  creator:{slug:'creator',runtime:'CONTAINER',surface:'DESKTOP',category:'CREATION',entrypoint:'selkies-gstreamer',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  // Delivered as CONTAINER/NOTEBOOK (JupyterLab + real GPU-accelerated FFmpeg/
  // NVENC), not the DESKTOP_VM this originally assumed: no VM/hypervisor
  // infrastructure exists in this codebase, and no official DaVinci Resolve
  // or GPU-accelerated Blender-desktop container was viable to build without
  // publishing a custom image (see docs/SESSION_RESUME.md). This profile is
  // corrected to match what's actually real, not what was first envisioned.
  video:{slug:'video',runtime:'CONTAINER',surface:'NOTEBOOK',category:'VIDEO',entrypoint:'jupyterlab',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  // Same correction as Cloud Desktop/Creator above - planned CONTAINER, not
  // built/tested yet.
  cad:{slug:'cad',runtime:'CONTAINER',surface:'DESKTOP',category:'CAD',entrypoint:'selkies-gstreamer',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  // Delivered as CONTAINER/CODE (code-server + a real Android SDK/Gradle
  // install, same surface as Developer), not the ISOLATED_VM/DESKTOP this
  // originally assumed: no VM/hypervisor infrastructure exists in this
  // codebase, and a graphical emulator specifically needs /dev/kvm, which is
  // confirmed absent on this host - see docs/SESSION_RESUME.md. This profile
  // is corrected to match what's actually real, not what was first envisioned.
  mobile:{slug:'mobile',runtime:'CONTAINER',surface:'CODE',category:'MOBILE',entrypoint:'code-server',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  // Delivered as CONTAINER/CODE (code-server + real tshark/YARA/radare2,
  // same surface as Developer/Mobile), not the ISOLATED_VM/DESKTOP this
  // originally assumed: no VM/hypervisor infrastructure exists in this
  // codebase. persistentWorkspace is now true - a renter's uploaded pcaps/
  // samples/binaries live on the same real mounted volume every other
  // workspace here uses - see docs/SESSION_RESUME.md.
  'security-lab':{slug:'security-lab',runtime:'CONTAINER',surface:'CODE',category:'SECURITY',entrypoint:'code-server',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  gaming:{slug:'gaming',runtime:'STREAMING_VM',surface:'STREAM',category:'GAMING',entrypoint:'stream-gateway',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
  // Delivered as CONTAINER/NOTEBOOK (JupyterLab + real ffmpeg audio DSP -
  // loudnorm, acompressor, equalizer), not the STREAMING_VM this originally
  // assumed: no streaming infrastructure (Sunshine/Moonlight-class UDP/WebRTC
  // tunneling) exists in this codebase, and the relay is TCP-only end to end.
  // An interactive Ardour/Audacity GUI would need the same broken-on-this-
  // host desktop-streaming path as Creator's Blender - see docs/SESSION_RESUME.md.
  audio:{slug:'audio',runtime:'CONTAINER',surface:'NOTEBOOK',category:'AUDIO',entrypoint:'jupyterlab',network:'EGRESS_POLICY',persistentWorkspace:true,hostAccess:false,dockerSocket:false,privileged:false},
});

export function workspaceRuntimeProfile(slug:string){return workspaceRuntimeProfiles[slug];}
