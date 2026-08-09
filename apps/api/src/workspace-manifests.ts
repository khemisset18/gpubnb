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
 manifest({slug:'ai',name:'AI Workspace',icon:'🤖',category:'AI',release:'UPCOMING',summary:'IA, modèles et génération',technologies:['Python','CUDA','PyTorch','JupyterLab'],license:'MIXED',minimum:{ramMiB:16384,diskMiB:30720,vramMiB:8192,cuda:true,docker:true,nvidiaRuntime:true},recommended:{ramMiB:32768,diskMiB:102400,vramMiB:16384}}),
 manifest({slug:'developer',name:'Developer Workspace',icon:'💻',category:'DEVELOPMENT',release:'BETA',summary:'Développement complet à distance',technologies:['VS Code','Git','Node.js','Python'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:8192,diskMiB:20480,docker:true},recommended:{ramMiB:16384,diskMiB:51200}}),
 manifest({slug:'cloud-desktop',name:'Cloud Desktop',icon:'☁️',category:'DESKTOP',release:'UPCOMING',summary:'Bureau distant isolé',technologies:['WebRTC','RDP','noVNC','Guacamole'],license:'MIXED',minimum:{ramMiB:8192,diskMiB:40960,virtualization:true},recommended:{ramMiB:16384,diskMiB:81920}}),
 manifest({slug:'compute',name:'Compute Workspace',icon:'⚡',category:'COMPUTE',release:'BETA',summary:'Tâches contrôlées sans bureau',technologies:['Docker','GPU','Batch','Logs'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:4096,diskMiB:10240,docker:true},recommended:{ramMiB:16384,diskMiB:51200,vramMiB:8192}}),
 manifest({slug:'api',name:'API Workspace',icon:'🔌',category:'API',release:'UPCOMING',summary:'Ressources accessibles par API',technologies:['REST','WebSocket','SDK','Webhooks'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:4096,diskMiB:10240,docker:true},recommended:{ramMiB:16384,diskMiB:30720}}),
 manifest({slug:'creator',name:'Creator Workspace',icon:'🎨',category:'CREATION',release:'UPCOMING',summary:'Graphisme et création 3D',technologies:['Blender','Krita','GIMP','Inkscape'],license:'MIXED',minimum:{ramMiB:16384,diskMiB:40960,vramMiB:6144},recommended:{ramMiB:32768,diskMiB:102400,vramMiB:12288}}),
 manifest({slug:'video',name:'Video Workspace',icon:'🎬',category:'VIDEO',release:'UPCOMING',summary:'Montage, rendu et encodage',technologies:['FFmpeg','DaVinci','Blender','NVENC'],license:'MIXED',minimum:{ramMiB:16384,diskMiB:102400,vramMiB:6144},recommended:{ramMiB:32768,diskMiB:204800,vramMiB:12288}}),
 manifest({slug:'data',name:'Data Workspace',icon:'📊',category:'DATA',release:'UPCOMING',summary:'Analyse et ingénierie des données',technologies:['Python','R','Jupyter','PostgreSQL'],license:'INCLUDED_OPEN_SOURCE',minimum:{ramMiB:16384,diskMiB:51200,docker:true},recommended:{ramMiB:32768,diskMiB:204800}}),
 manifest({slug:'mobile',name:'Mobile Workspace',icon:'📱',category:'MOBILE',release:'UPCOMING',summary:'Développement Android et mobile',technologies:['Android Studio','Flutter','React Native','ADB'],license:'MIXED',minimum:{ramMiB:16384,diskMiB:61440,virtualization:true},recommended:{ramMiB:32768,diskMiB:122880}}),
 manifest({slug:'security-lab',name:'Security Lab',icon:'🛡️',category:'SECURITY',release:'EXPERIMENTAL',summary:'Laboratoire défensif très isolé',technologies:['Kali','Wireshark','Burp Suite','CTF'],license:'MIXED',minimum:{ramMiB:16384,diskMiB:51200,virtualization:true},recommended:{ramMiB:32768,diskMiB:102400}}),
 manifest({slug:'cad',name:'CAD Workspace',icon:'📐',category:'CAD',release:'UPCOMING',summary:'CAO, simulation et ingénierie',technologies:['FreeCAD','Blender','AutoCAD','Fusion 360'],license:'USER_LICENSE_REQUIRED',minimum:{ramMiB:16384,diskMiB:61440,vramMiB:6144},recommended:{ramMiB:32768,diskMiB:122880,vramMiB:12288}}),
 manifest({slug:'gaming',name:'Gaming Workspace',icon:'🎮',category:'GAMING',release:'EXPERIMENTAL',summary:'Jeu distant sous licences utilisateur',technologies:['Sunshine','Moonlight','Steam','WebRTC'],license:'USER_ACCOUNT_REQUIRED',minimum:{ramMiB:16384,diskMiB:102400,vramMiB:8192,virtualization:true},recommended:{ramMiB:32768,diskMiB:204800,vramMiB:12288}}),
 manifest({slug:'audio',name:'Audio Workspace',icon:'🎧',category:'AUDIO',release:'UPCOMING',summary:'Production et traitement audio',technologies:['Ardour','Audacity','PipeWire','VST'],license:'MIXED',minimum:{ramMiB:8192,diskMiB:40960},recommended:{ramMiB:16384,diskMiB:102400}}),
]);

export function workspaceManifest(slug:string){return workspaceManifests.find(item=>item.slug===slug);}
