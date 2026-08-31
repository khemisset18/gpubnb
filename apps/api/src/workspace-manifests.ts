export type WorkspaceCategory = 'AI'|'DEVELOPMENT'|'DESKTOP'|'COMPUTE'|'API'|'CREATION'|'VIDEO'|'DATA'|'MOBILE'|'SECURITY'|'CAD'|'GAMING'|'AUDIO';
export type WorkspaceRelease = 'BETA'|'UPCOMING'|'EXPERIMENTAL';
export type WorkspaceManifest = {
  slug:string; name:string; icon:string; category:WorkspaceCategory; release:WorkspaceRelease;
  summary:string; technologies:string[]; license:'INCLUDED_OPEN_SOURCE'|'USER_ACCOUNT_REQUIRED'|'USER_LICENSE_REQUIRED'|'MIXED';
  minimum:{ramMiB:number;diskMiB:number;vramMiB?:number;cuda?:boolean;docker?:boolean;virtualization?:boolean;nvidiaRuntime?:boolean;desktopGpuRendering?:boolean};
  recommended:{ramMiB:number;diskMiB:number;vramMiB?:number};
};

const manifest=(value:WorkspaceManifest)=>Object.freeze(value);
export const workspaceManifests:readonly WorkspaceManifest[]=Object.freeze([
 manifest({slug:'ai',name:'AI Workspace',icon:'🤖',category:'AI',release:'BETA',summary:'IA, modèles et génération',technologies:['Python','CUDA','PyTorch','JupyterLab'],license:'MIXED',minimum:{ramMiB:16384,diskMiB:30720,vramMiB:8192,cuda:true,docker:true,nvidiaRuntime:true},recommended:{ramMiB:32768,diskMiB:102400,vramMiB:16384}}),
 manifest({slug:'developer',name:'Developer Workspace',icon:'💻',category:'DEVELOPMENT',release:'BETA',summary:'Développement complet à distance',technologies:['VS Code','Git','Node.js','Python'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:8192,diskMiB:20480,docker:true,cuda:true,nvidiaRuntime:true},recommended:{ramMiB:16384,diskMiB:51200}}),
 // 'RDP', 'noVNC' and 'Guacamole' intentionally absent from `technologies`:
 // none is the real planned architecture. What's real (researched, not yet
 // built - no Linux GPU host to build/test it on, see
 // docs/SESSION_RESUME.md section 8): a Selkies-GStreamer-based image
 // (e.g. linuxserver/webtop), a real GPU-accelerated Linux desktop
 // streamed over WebRTC, not a VM (`virtualization` dropped - this is
 // planned as a CONTAINER, see workspace-runtime-profiles.ts). Requires a
 // real /dev/dri render node + the NVIDIA Container Toolkit - see
 // `desktopGpuRendering` below and platform_info.desktop_gpu_rendering_available().
 manifest({slug:'cloud-desktop',name:'Cloud Desktop',icon:'☁️',category:'DESKTOP',release:'UPCOMING',summary:'Bureau Linux distant avec rendu GPU réel (architecture prête, aucun hôte Linux GPU disponible pour le valider)',technologies:['Selkies-GStreamer','WebRTC'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:8192,diskMiB:40960,vramMiB:2048,docker:true,nvidiaRuntime:true,desktopGpuRendering:true},recommended:{ramMiB:16384,diskMiB:81920,vramMiB:4096}}),
 manifest({slug:'compute',name:'Compute Workspace',icon:'⚡',category:'COMPUTE',release:'BETA',summary:'Tâches contrôlées sans bureau',technologies:['Docker','GPU','Batch','Logs'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:4096,diskMiB:10240,docker:true},recommended:{ramMiB:16384,diskMiB:51200,vramMiB:8192}}),
 // 'SDK' and 'Webhooks' intentionally absent from `technologies`: GPUbnb
 // ships no SDK and no webhook mechanism. What's real: the official
 // quay.io/jupyter/datascience-notebook image launched headless
 // (DOCKER_STACKS_JUPYTER_CMD=server, every notebook/lab UI extension
 // disabled), exposing only jupyter_server's own documented REST + WebSocket
 // kernel API - a renter creates a kernel and executes code from their own
 // script/CI, not by clicking around in a browser (confirmed live: /lab and
 // /tree both 404, a real REST-created kernel executes real code over its
 // WebSocket channel and returns the real result). CPU-only by design - see
 // runtime_images.DEFAULT_API_IMAGE and docs/SESSION_RESUME.md.
 manifest({slug:'api',name:'API Workspace',icon:'🔌',category:'API',release:'BETA',summary:'Exécution de code à distance via une API REST/WebSocket, sans interface graphique',technologies:['REST','WebSocket','Jupyter Server API','Python'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:4096,diskMiB:10240,docker:true},recommended:{ramMiB:16384,diskMiB:30720}}),
 // 'Krita', 'GIMP' and 'Inkscape' intentionally absent from `technologies`:
 // not confirmed bundled in the real candidate image
 // (`linuxserver/blender`, digest recorded and inspected earlier this
 // session - only Blender itself was verified). Same Selkies-based
 // architecture as Cloud Desktop, not yet buildable/testable here - see
 // docs/SESSION_RESUME.md section 8.
 manifest({slug:'creator',name:'Creator Workspace',icon:'🎨',category:'CREATION',release:'UPCOMING',summary:'Blender avec rendu GPU réel en environnement isolé (architecture prête, aucun hôte Linux GPU disponible pour le valider)',technologies:['Blender','Selkies-GStreamer','WebRTC'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:16384,diskMiB:40960,vramMiB:6144,docker:true,nvidiaRuntime:true,desktopGpuRendering:true},recommended:{ramMiB:32768,diskMiB:102400,vramMiB:12288}}),
 // DaVinci Resolve and an interactive Blender desktop are intentionally
 // absent from `technologies`: no official freely-redistributable Linux
 // container exists for DaVinci, and a GPU-accelerated Blender desktop needs
 // a containerized-remote-desktop runtime this platform doesn't have working
 // GPU rendering support for yet (DRI/DRM passthrough isn't exposed the same
 // way under Windows/WSL2 Docker Desktop - see docs/SESSION_RESUME.md).
 // What's real: JupyterLab with an ffmpeg build that has genuine hardware
 // h264_nvenc/hevc_nvenc/av1_nvenc encoders, GPU-passthrough-verified live.
 manifest({slug:'video',name:'Video Workspace',icon:'🎬',category:'VIDEO',release:'BETA',summary:'Encodage et transcodage vidéo accélérés par GPU',technologies:['FFmpeg','NVENC','JupyterLab','Python'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:16384,diskMiB:102400,vramMiB:6144,docker:true,nvidiaRuntime:true},recommended:{ramMiB:32768,diskMiB:204800,vramMiB:12288}}),
 // PostgreSQL intentionally absent from `technologies`: the real runtime is the
 // official quay.io/jupyter/datascience-notebook image used as-is (no
 // GPUbnb-built/published image exists to add psycopg2/postgresql-client to -
 // see runtime_images.DEFAULT_DATA_IMAGE and docs/SESSION_RESUME.md). Never
 // re-add it here without a real client library actually present in the image.
 manifest({slug:'data',name:'Data Workspace',icon:'📊',category:'DATA',release:'BETA',summary:'Analyse et ingénierie des données',technologies:['Python','R','JupyterLab','pandas','scikit-learn'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:16384,diskMiB:51200,docker:true},recommended:{ramMiB:32768,diskMiB:204800}}),
 // 'Android Studio', 'Flutter' and 'React Native' intentionally absent from
 // `technologies`: none is installed. What's real: a custom GPUbnb image
 // (workspaces/mobile/Dockerfile, built FROM the already-proven Developer
 // image) adding a real Android SDK (platform-tools, build-tools, a current
 // platform) and a real Gradle install to the same code-server terminal/
 // editor Developer Workspace already has - confirmed live with a real
 // `gradlew assembleDebug` producing a real .aar, fully offline. No
 // graphical emulator: `virtualization` dropped from `minimum` too - this
 // runs as a plain container needing no hardware virtualization at all
 // (real measured requirement, not the assumed-but-never-built VM this
 // manifest originally specified) - see docs/SESSION_RESUME.md for why a
 // graphical emulator specifically stays unavailable (/dev/kvm).
 manifest({slug:'mobile',name:'Mobile Workspace',icon:'📱',category:'MOBILE',release:'BETA',summary:'Développement et build Android en environnement headless (sans émulateur graphique)',technologies:['Android SDK','Gradle','ADB','VS Code'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:16384,diskMiB:61440,docker:true},recommended:{ramMiB:32768,diskMiB:122880}}),
 // 'Kali', 'Burp Suite' and 'CTF' intentionally absent from `technologies`:
 // none is installed or installable as claimed. What's real: a custom
 // GPUbnb image (workspaces/security-lab/Dockerfile, built FROM the
 // already-proven Developer image) adding real tshark/YARA/radare2 - all
 // official Ubuntu packages, GPL/BSD, no manual download needed. Product
 // scope decided explicitly with the user: a real DEFENSIVE analysis lab,
 // not an offensive pentesting toolkit - no nmap/sqlmap/hydra/Metasploit
 // (every session's real container has zero route to the public internet
 // or to any other machine, so an offensive tool would have no reachable
 // target - only added labeling risk, no real capability). No Burp Suite:
 // its Community Edition EULA does not permit bundling into a
 // redistributable image. Confirmed live: a real crafted pcap parsed by
 // tshark, a real YARA rule match, and a real radare2 analysis of an actual
 // ELF binary. `virtualization` dropped from `minimum` too - this runs as a
 // plain container, not a VM - see docs/SESSION_RESUME.md.
 manifest({slug:'security-lab',name:'Security Lab',icon:'🛡️',category:'SECURITY',release:'BETA',summary:'Analyse forensique et rétro-ingénierie en environnement isolé (pas d\'accès réseau live)',technologies:['Wireshark','YARA','radare2','VS Code'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:8192,diskMiB:20480,docker:true},recommended:{ramMiB:16384,diskMiB:51200}}),
 // 'AutoCAD' and 'Fusion 360' intentionally absent from `technologies`:
 // both are proprietary, Windows/licensed-cloud software with no real
 // redistributable Linux container path - never actually plannable here.
 // What's real: FreeCAD (GPL, real, `apt`-installable) layered onto the
 // same Selkies-based desktop image as Cloud Desktop/Creator - the exact
 // pattern already proven twice this session (Mobile: Android SDK onto
 // Developer; Security Lab: tshark/YARA/radare2 onto Developer). Not yet
 // buildable/testable here - see docs/SESSION_RESUME.md section 8.
 manifest({slug:'cad',name:'CAD Workspace',icon:'📐',category:'CAD',release:'UPCOMING',summary:'FreeCAD avec rendu GPU réel en environnement isolé (architecture prête, aucun hôte Linux GPU disponible pour le valider)',technologies:['FreeCAD','Selkies-GStreamer','WebRTC'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:16384,diskMiB:61440,vramMiB:6144,docker:true,nvidiaRuntime:true,desktopGpuRendering:true},recommended:{ramMiB:32768,diskMiB:122880,vramMiB:12288}}),
 manifest({slug:'gaming',name:'Gaming Workspace',icon:'🎮',category:'GAMING',release:'EXPERIMENTAL',summary:'Jeu distant sous licences utilisateur',technologies:['Sunshine','Moonlight','Steam','WebRTC'],license:'USER_ACCOUNT_REQUIRED',minimum:{ramMiB:16384,diskMiB:102400,vramMiB:8192,virtualization:true},recommended:{ramMiB:32768,diskMiB:204800,vramMiB:12288}}),
 // An interactive Ardour/Audacity GUI and VST plugin hosting are
 // intentionally absent from `technologies`: both need the same
 // containerized-remote-desktop runtime this platform doesn't have working
 // GPU rendering support for yet (see docs/SESSION_RESUME.md). What's real:
 // JupyterLab with an ffmpeg build that has genuine audio DSP filters
 // (loudnorm EBU R128 normalization, acompressor, multi-band equalizers),
 // confirmed live with a real processed .wav file. No GPU is used or needed.
 manifest({slug:'audio',name:'Audio Workspace',icon:'🎧',category:'AUDIO',release:'BETA',summary:'Traitement et normalisation audio par script',technologies:['FFmpeg','JupyterLab','Python'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:8192,diskMiB:40960,docker:true},recommended:{ramMiB:16384,diskMiB:102400}}),
]);

export function workspaceManifest(slug:string){return workspaceManifests.find(item=>item.slug===slug);}
