# GPUbnb Workspaces — état réel, référence pour les développeurs

Ce document est la référence officielle sur l'état réel des 13 Workspaces
GPUbnb. Il répond à une seule question à chaque fois : **est-ce réellement
testé et fonctionnel, ou pas ?** Un Workspace n'est jamais présenté comme
fonctionnel s'il ne l'est pas réellement.

Pour l'architecture technique (comment un Workspace est lancé, contrôlé,
healthchecké, arrêté), voir `docs/WORKSPACE_RUNTIME_ARCHITECTURE.md`. Pour
la procédure complète de reprise du développement sur une vraie machine
Linux + GPU NVIDIA (checklist pas à pas), voir `docs/SESSION_RESUME.md`
section 9.

## Statuts utilisés

- **REAL_WORKING** — testé de bout en bout sur infrastructure réelle
  (conteneur réel, healthcheck réel, relais Gateway réel, arrêt/cleanup
  réel vérifié). Présent dans `executableWorkspaceSlugs`
  (`apps/api/src/machine-workspace-catalog.ts`) et
  `GATEWAY_WORKSPACE_SLUGS` (`agent/gpubnb_agent/workspace_gateway.py`) —
  donc réellement réservable.
- **BLOCKED** — architecture, image Docker et code de lancement réels et
  préparés, mais **non réservable** : absent des deux listes ci-dessus.
  Bloqué par une limitation matérielle réelle et documentée, jamais une
  simulation présentée comme une validation.

Aucun statut `PARTIALLY_WORKING` n'est nécessaire actuellement : chaque
Workspace est soit entièrement validé, soit honnêtement bloqué.

## Tableau des 13 Workspaces

| Workspace | Statut | Runtime | GPU requis | VRAM min | RAM min | Dépendances clés | Limitation |
|---|---|---|---|---|---|---|---|
| Compute | REAL_WORKING | Conteneur (image officielle `gpu-proof-workspace`) | Non (calcul CUDA en option) | — | 4096 MiB | Docker | Job batch contrôlé, pas de bureau |
| Developer | REAL_WORKING | Conteneur (image `gpubnb-developer`, code-server) | Oui (CUDA compute) | — | 8192 MiB | Docker, NVIDIA Container Toolkit | — |
| Data | REAL_WORKING | Conteneur (`quay.io/jupyter/datascience-notebook`, officielle) | Non | — | 16384 MiB | Docker | Pas d'outillage client PostgreSQL |
| AI | REAL_WORKING | Conteneur (`quay.io/jupyter/pytorch-notebook`, officielle) | Oui (CUDA compute) | 8192 MiB | 16384 MiB | Docker, NVIDIA Container Toolkit | — |
| Video | REAL_WORKING | Conteneur (image Data + FFmpeg NVENC réel) | Oui (CUDA + capacité `video`) | 6144 MiB | 16384 MiB | Docker, NVIDIA Container Toolkit | Pas de GUI Blender/DaVinci |
| Audio | REAL_WORKING | Conteneur (image Data + FFmpeg DSP) | Non | — | 8192 MiB | Docker | Pas de GUI Ardour/Audacity/VST |
| API | REAL_WORKING | Conteneur (jupyter_server headless, REST/WS) | Non | — | 4096 MiB | Docker | API pure, pas d'interface |
| Mobile | REAL_WORKING | Conteneur (image locale custom, Android SDK/Gradle) | Non | — | 16384 MiB | Docker | Build headless, pas d'émulateur graphique (`/dev/kvm` absent) |
| Security Lab | REAL_WORKING | Conteneur (image locale custom, tshark/YARA/radare2) | Non | — | 8192 MiB | Docker | Pas de capture live, pas d'outils offensifs (nmap/Metasploit exclus) |
| Cloud Desktop | **BLOCKED** | Conteneur (`linuxserver/webtop`, Selkies-GStreamer) | Oui (rendu GPU desktop, pas seulement CUDA) | 2048 MiB | 8192 MiB | Docker, NVIDIA Container Toolkit, `/dev/dri` fonctionnel | Aucun hôte Linux GPU disponible pour valider le rendu |
| Creator | **BLOCKED** | Conteneur (webtop + Blender réel) | Oui (rendu GPU desktop) | 6144 MiB | 16384 MiB | idem + Blender (paquet officiel Ubuntu) | idem |
| CAD | **BLOCKED** | Conteneur (webtop + FreeCAD réel) | Oui (rendu GPU desktop) | 6144 MiB | 16384 MiB | idem + FreeCAD (PPA tiers `xtradeb`, documenté) | idem |
| Gaming | **BLOCKED** | Conteneur (webtop + Steam réel) | Oui (rendu GPU desktop) | 8192 MiB | 16384 MiB | idem + Steam (paquet officiel Ubuntu multiverse) | idem + politique de contenu à définir |

Aucun Workspace bloqué n'apparaît dans `executableWorkspaceSlugs` ni dans
`GATEWAY_WORKSPACE_SLUGS` — vérifiable directement dans le code, pas
seulement dans ce document.

## Les 9 Workspaces REAL_WORKING — ce qui a été réellement testé

Chacun a été validé via le chemin de production complet : réservation
réelle → `WorkspaceSession` → conteneur réel démarré par l'agent → relais
`loopback-proxy.js` réel → Gateway réel → arrêt réel → cleanup vérifié
(conteneur, volume, réseau tous confirmés disparus).

- **Compute / Developer** : fondation historique, prouvée par le premier
  harness E2E (`e2e/run.sh`), y compris un scénario réel de crash/reprise
  de l'agent (`e2e/recovery-agent-restart.sh`).
- **Data** : JupyterLab réel, aucune dépendance GPU.
- **AI** : JupyterLab + PyTorch + CUDA réel, passthrough `--gpus` scopé à
  l'UUID matériel exact loué ; vérifié en direct :
  `torch.cuda.get_device_name(0)` retourne le vrai nom du GPU dans le
  conteneur réellement en cours d'exécution.
- **Video** : même image que Data, dont le build ffmpeg inclut de vrais
  encodeurs matériels (`h264_nvenc`/`hevc_nvenc`/`av1_nvenc`) ; un vrai
  encodage `h264_nvenc` a été produit en direct et écrit sur le volume
  persistant. La capacité pilote `video` (pas seulement
  `compute,utility`) s'est révélée nécessaire — sans elle, échec franc,
  jamais de repli logiciel silencieux.
- **Audio** : même image, filtres DSP audio réels (loudnorm EBU R128,
  compresseur, égaliseurs) ; aucun GPU attaché (`HostConfig.DeviceRequests`
  vérifié `null` en direct).
- **API** : `jupyter_server` lancé en mode headless
  (`DOCKER_STACKS_JUPYTER_CMD=server`), toutes les extensions UI
  désactivées ; vérifié en direct via le relais complet : un vrai noyau
  créé par `POST /api/kernels`, du vrai code exécuté sur son canal
  WebSocket, le vrai résultat lu en retour.
- **Mobile** : première image GPUbnb custom, construite et utilisée
  localement (non publiée sur un registre), avec un vrai SDK Android et
  un vrai Gradle. Aucun émulateur graphique (`/dev/kvm` absent, non
  simulé). Preuve produit réelle : un vrai
  `./gradlew assembleDebug --offline` exécuté **dans le conteneur de
  session réellement en cours d'exécution**, produisant un vrai
  `lib-debug.aar`.
- **Security Lab** : deuxième image custom locale, scope produit
  explicitement validé avec l'utilisateur avant construction (laboratoire
  d'analyse **défensive**, pas offensif). `tshark`/`YARA`/`radare2` réels,
  testés en direct sur un pcap et un binaire ELF réels.

## Les 4 Workspaces BLOCKED — raison exacte

Creator, Cloud Desktop, CAD et Gaming partagent exactement la même cause
de blocage : **l'hôte de développement actuel (Windows 11 / WSL2 / Docker
Desktop) ne peut pas exposer de rendu GPU desktop réel.** Ce n'est pas un
problème de code GPUbnb — l'architecture, les images Docker et le code de
lancement sont tous réels et prêts (voir plus bas).

### CUDA compute ≠ rendu GPU desktop

Ce sont deux capacités **différentes et mesurées indépendamment** :

- **CUDA compute** (`cudaVersion`, `nvidiaRuntimeAvailable`) : ce que
  Developer/AI/Video/Mobile utilisent. Fonctionne réellement sur cet hôte
  via `/dev/dxg` (le device DXCore de WSL2) et le NVIDIA Container
  Toolkit.
- **Rendu GPU desktop** (`desktopGpuRenderingAvailable`) : OpenGL, Vulkan,
  EGL — ce dont Selkies/Blender/FreeCAD/Steam ont besoin. Nécessite un
  vrai nœud DRM (`/dev/dri/renderD128`), **absent** de cet hôte.

La preuve que ce sont deux capacités indépendantes, pas une hiérarchie :
ce GPU (GTX 1650) a un vrai calcul CUDA fonctionnel **et** un vrai
encodage matériel NVENC fonctionnel, mais **zéro** rendu GPU desktop —
confirmé au niveau noyau (`/sys/class/drm` est vide), pas juste "pas
configuré".

### Pourquoi le CPU/`swrast` ne compte jamais comme validation

Sur cet hôte, la seule voie EGL qui s'initialise est `Surfaceless`, avec
`EGL driver name: swrast` — le rasterizer logiciel CPU de Mesa. Ceci
**n'est jamais présenté comme un rendu GPU** dans ce dépôt, nulle part.
Un Workspace bloqué reste bloqué même si un rendu logiciel technique est
possible — la barre est le rendu GPU physique réel, pas un succès
technique quelconque.

### Ce qui bloque précisément, au niveau noyau

- `/dev/dri` absent partout testé (WSL2 natif, conteneurs Docker) —
  `/sys/class/drm/` est vide, ce n'est pas un problème de permissions ou
  de fichier de device manquant.
- `dxgkrnl` (le pilote qui crée `/dev/dxg`) s'enregistre comme
  périphérique `misc`, pas comme périphérique DRM ; ses requêtes
  `query_adapter_info` échouent réellement (`dmesg` : dizaines
  d'occurrences réelles, reproductibles à la demande).
- Le vrai pilote Mesa D3D12 Gallium (`d3d12_dri.so`, réellement installé)
  a besoin exactement de ce `/dev/dri` absent pour s'initialiser —
  confirmé par `eglinfo` et en forçant `GALLIUM_DRIVER=d3d12`.
- Les bibliothèques Vulkan/OpenGL propriétaires NVIDIA pour WSL2
  n'existent pas sur ce pilote (592.82) — seules les bibliothèques de
  calcul sont fournies.
- Windows 11 **Home** n'a pas Hyper-V du tout — le passthrough GPU complet
  via VM (DDA) n'est même pas installable sur cette édition, indépendamment
  du fait que les pilotes GeForce grand public sont documentés pour se
  désactiver dans la plupart des configurations virtualisées ("Code 43").

Étude complète, avec chaque commande réellement exécutée et chaque
résultat brut : `docs/SESSION_RESUME.md` section 10.

### Matériel nécessaire pour débloquer ces 4 Workspaces

Un hôte **Linux** (bare-metal ou VM avec passthrough GPU réel — pas
WSL2) avec :

- un GPU NVIDIA réel (consumer ou datacenter) ;
- le pilote propriétaire NVIDIA installé nativement (pas WDDM/WSL) ;
- Docker Engine + NVIDIA Container Toolkit ;
- un vrai `/dev/dri/renderD128` fonctionnel, prouvé par un rendu OpenGL
  matériel réel (pas `llvmpipe`/`softpipe`/`swrast`).

## Ce qui est déjà préparé pour ce futur hôte Linux

Rien de ceci n'a besoin d'être réécrit une fois la machine disponible —
seule la validation matérielle reste à faire :

- **`scripts/preflight-linux-gpu-desktop.sh`** — script de diagnostic
  autonome, lecture seule, à lancer sur la future machine avant même
  d'installer l'agent GPUbnb. Distingue explicitement calcul CUDA et
  rendu GPU desktop, teste OpenGL (chaîne du renderer, pas juste le code
  de sortie) et NVENC.
- **Détection `desktopGpuRenderingAvailable`** — champ réel, mesuré
  indépendamment, de bout en bout : agent
  (`platform_info.desktop_gpu_rendering_available()`), migration Prisma,
  heartbeat, moteur de compatibilité (`workspace-compatibility.ts`).
- **4 images Docker réelles**, construites et testées en direct
  (démarrage conteneur, binaire applicatif réel, HTTP 200 via le vrai
  relais) : `workspaces/{cloud-desktop,creator,cad,gaming}/Dockerfile`,
  toutes basées sur `linuxserver/webtop` (Selkies-GStreamer).
- **Code de lancement agent partagé**, réel et testé unitairement mais
  volontairement non branché (`agent/gpubnb_agent/workspace_gateway.py`,
  `workspace_gateway_v5.py`, `runtime_images.py`) — profil de lancement
  commun aux 4 Workspaces (pas 4 implémentations différentes), utilisant
  le vrai relais `loopback-proxy.js` déjà en production pour les 9
  Workspaces REAL_WORKING.
- **Profils runtime et manifestes cohérents** — `workspace-runtime-profiles.ts`,
  `workspace-manifests.ts` : les 4 marquent `desktopGpuRendering:true`,
  runtime `CONTAINER` (pas de VM fictive), `release:'UPCOMING'`/`'EXPERIMENTAL'`.

**Ce qu'il reste réellement à faire sur la vraie machine Linux** : suivre
la checklist de validation en 10 étapes de `docs/SESSION_RESUME.md`
section 9 (preflight → build → test manuel `--gpus` → confirmation
rendu/clavier/souris/gamepad/audio réels → seulement alors, ajout aux
listes réservables → cycle complet réservation→lancement→accès→arrêt→cleanup
via la vraie plateforme → mise à jour des manifestes).
