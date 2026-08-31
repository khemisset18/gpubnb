export type WorkspaceCategory = 'AI'|'DEVELOPMENT'|'DESKTOP'|'COMPUTE'|'API'|'CREATION'|'VIDEO'|'DATA'|'MOBILE'|'SECURITY'|'CAD'|'GAMING'|'AUDIO';
export type WorkspaceRelease = 'BETA'|'UPCOMING'|'EXPERIMENTAL';
export type WorkspaceManifest = {
  slug:string; name:string; icon:string; category:WorkspaceCategory; release:WorkspaceRelease;
  summary:string; technologies:string[]; license:'INCLUDED_OPEN_SOURCE'|'USER_ACCOUNT_REQUIRED'|'USER_LICENSE_REQUIRED'|'MIXED';
  minimum:{ramMiB:number;diskMiB:number;vramMiB?:number;cuda?:boolean;docker?:boolean;virtualization?:boolean;nvidiaRuntime?:boolean};
  recommended:{ramMiB:number;diskMiB:number;vramMiB?:number};
};

const manifest=(value:WorkspaceManifest)=>Object.freeze(value);
export const workspaceManifests:readonly WorkspaceManifest[]=Object.freeze([
 manifest({slug:'ai',name:'AI Workspace',icon:'🤖',category:'AI',release:'BETA',summary:'IA, modèles et génération',technologies:['Python','CUDA','PyTorch','JupyterLab'],license:'MIXED',minimum:{ramMiB:16384,diskMiB:30720,vramMiB:8192,cuda:true,docker:true,nvidiaRuntime:true},recommended:{ramMiB:32768,diskMiB:102400,vramMiB:16384}}),
 manifest({slug:'developer',name:'Developer Workspace',icon:'💻',category:'DEVELOPMENT',release:'BETA',summary:'Développement complet à distance',technologies:['VS Code','Git','Node.js','Python'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:8192,diskMiB:20480,docker:true,cuda:true,nvidiaRuntime:true},recommended:{ramMiB:16384,diskMiB:51200}}),
 manifest({slug:'cloud-desktop',name:'Cloud Desktop',icon:'☁️',category:'DESKTOP',release:'UPCOMING',summary:'Bureau distant isolé',technologies:['WebRTC','RDP','noVNC','Guacamole'],license:'MIXED',minimum:{ramMiB:8192,diskMiB:40960,virtualization:true},recommended:{ramMiB:16384,diskMiB:81920}}),
 manifest({slug:'compute',name:'Compute Workspace',icon:'⚡',category:'COMPUTE',release:'BETA',summary:'Tâches contrôlées sans bureau',technologies:['Docker','GPU','Batch','Logs'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:4096,diskMiB:10240,docker:true},recommended:{ramMiB:16384,diskMiB:51200,vramMiB:8192}}),
 manifest({slug:'api',name:'API Workspace',icon:'🔌',category:'API',release:'UPCOMING',summary:'Ressources accessibles par API',technologies:['REST','WebSocket','SDK','Webhooks'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:4096,diskMiB:10240,docker:true},recommended:{ramMiB:16384,diskMiB:30720}}),
 manifest({slug:'creator',name:'Creator Workspace',icon:'🎨',category:'CREATION',release:'UPCOMING',summary:'Graphisme et création 3D',technologies:['Blender','Krita','GIMP','Inkscape'],license:'MIXED',minimum:{ramMiB:16384,diskMiB:40960,vramMiB:6144},recommended:{ramMiB:32768,diskMiB:102400,vramMiB:12288}}),
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
 manifest({slug:'mobile',name:'Mobile Workspace',icon:'📱',category:'MOBILE',release:'UPCOMING',summary:'Développement Android et mobile',technologies:['Android Studio','Flutter','React Native','ADB'],license:'MIXED',minimum:{ramMiB:16384,diskMiB:61440,virtualization:true},recommended:{ramMiB:32768,diskMiB:122880}}),
 manifest({slug:'security-lab',name:'Security Lab',icon:'🛡️',category:'SECURITY',release:'EXPERIMENTAL',summary:'Laboratoire défensif très isolé',technologies:['Kali','Wireshark','Burp Suite','CTF'],license:'MIXED',minimum:{ramMiB:16384,diskMiB:51200,virtualization:true},recommended:{ramMiB:32768,diskMiB:102400}}),
 manifest({slug:'cad',name:'CAD Workspace',icon:'📐',category:'CAD',release:'UPCOMING',summary:'CAO, simulation et ingénierie',technologies:['FreeCAD','Blender','AutoCAD','Fusion 360'],license:'USER_LICENSE_REQUIRED',minimum:{ramMiB:16384,diskMiB:61440,vramMiB:6144},recommended:{ramMiB:32768,diskMiB:122880,vramMiB:12288}}),
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
