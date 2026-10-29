# GPUbnb — incubateur des six nouveaux Workspaces

**Statut : DESIGN_ONLY.** Les entrées de catalogue et profils de runtime ne
sont **pas** des conteneurs fonctionnels ni des images validées. Aucun de ces
six studios n'est réservé, facturé, publié ou accessible depuis le Gateway.
Ce lot ne change pas les 9 Workspaces REAL_WORKING ni les quatre bloqués.

## Ordre de développement

1. AI Image Studio — image ComfyUI + modèle et dépendances autorisés, puis rendu et preuve Gateway.
2. LLM Studio — serveur Ollama/vLLM et modèle autorisés, réponse réelle et limites VRAM.
3. Voice AI Studio — transcription/TTS, données personnelles éphémères, modèles autorisés.
4. AI Training Studio — LoRA, checkpoints, interruptions et nettoyage.
5. 3D Rendering Studio — Blender batch CUDA sur GPU physique, sans faux rendu CPU.
6. Game Server Studio — **nouveau design réseau nécessaire** : UDP/ports joueur, quotas, filtrage, isolation, licences; ne pas connecter au Gateway HTTP existant par simple redirection.

## Contrat de promotion obligatoire par studio

- Vérifier les licences, provenance, digests immuables et l'analyse de vulnérabilités de l'image et des modèles.
- Conserver le même contrôle d'autorité signé : **UUID GPU exact**, préemption du seul mineur concerné, fencing anti-race, incompatibilité explicite.
- Exécuter un vrai job fonctionnel sur du matériel compatible, via le Gateway authentifié (si interactif), avec test négatif d'accès non autorisé.
- Prouver réservation → préparation → première réponse utilisable → activation de la facturation → arrêt → destruction conteneur/volume/réseau → libération du GPU; retour du minage **uniquement sur opt-in propriétaire**.
- Vérifier garde thermique/VRAM, quotas RAM/CPU/disque, politiques réseau, secret handling, absence de socket Docker ou de montage hôte privé.
- Reproduire la preuve sur Windows/WSL2 ou Linux selon capacités ; publication multi-machine et image téléchargeable avant toute activation publique.
- **Seules après preuve** : intégrer l'image épinglée dans runtime_images, les chemins de lancement/healthcheck Agent, les deux listes d'exécutables API/Agent, les routes et tests E2E. Ne jamais modifier ces listes sur la base du manifeste seul.

## Limites particulières

- ComfyUI/LLM/Voice : GPU utilisé pour du travail potentiel sur données personnelles; accès aux modèles sans téléchargement arbitraire dans la session et pas de modèle redistribué sans droit.
- Training : taille des checkpoints, reprise, pertes de données et limites GPU pendant la réservation.
- Blender : le rendu Cycles headless CUDA n'est **pas** la même chose que l'ancien Creator GUI exigeant /dev/dri ; les deux doivent être qualifiés séparément.
- Game Server : la plupart des serveurs demandent des ports TCP/UDP entrants, contre la topologie actuelle loopback/Gateway TCP; aucune exception réseau ou diffusion publique avant conception revue.

## Hors périmètre

DOGE, D2–D9, swap, BTC/LTC/BCH/XMR, wallets, signatures, minage effectif,
production, déploiement, paiement, merge sur main, nouveaux tarifs ou frais.

## Logiciels réellement décrits dans ce commit (mais images non construites)

| Studio | Image source | Logiciel à installer par `docker build` | Surface prévue | Limitation restante |
|---|---|---|---|---|
| AI Image Studio | PyTorch/Jupyter officiel, digest fixé | ComfyUI au commit `fd7639f` et dépendances | HTTP 3000 `/system_stats` | Aucun modèle SD/Flux encore livré ou qualifié; génération réelle non prouvée |
| LLM Studio | PyTorch/Jupyter officiel, digest fixé | Transformers, Accelerate, modèle HF à commit obligatoire | HTTP 3000 `/generate` | Build nécessite `MODEL_REPO` + `MODEL_COMMIT` revus ; aucune réponse GPU prouvée |
| Voice AI Studio | PyTorch/Jupyter officiel, digest fixé | FFmpeg, Whisper + modèle tiny préchargé | HTTP 3000 `/transcribe` | **Transcription seulement** ; TTS non livré ; aucun audio réel GPU qualifié |
| AI Training Studio | PyTorch/Jupyter officiel, digest fixé | Transformers, Accelerate, PEFT/LoRA | JupyterLab 3000, `lora-smoke.py` | LoRA CUDA sur GPU loué non testé ; checkpoints à qualifier |
| 3D Rendering Studio | Developer GPUbnb, digest fixé | Blender paquet Ubuntu + test Cycles CUDA | Code Server 3000, rendu batch | Le CPU doit rester exclu ; pas de preuve CUDA/Cycles encore |
| Game Server Studio | Developer GPUbnb, digest fixé | Java existant + jar officiel Mojang à SHA obligatoire | TCP jeu 25565 (non exposé) | EULA explicite, réseau sécurisé/ports TCP+UDP et clients réels NON qualifiés ; Palworld non livré |

### Construire un candidat sur machine de test isolée

```sh
# Requiert Docker et l'accès aux dépôts officiels au moment du build,
# mais n'active aucune annonce et n'installe aucun logiciel sur le PC hôte.
sh workspaces/incubator/build-candidates.sh ai-image-studio
sh workspaces/incubator/build-candidates.sh voice-ai-studio
sh workspaces/incubator/build-candidates.sh ai-training-studio
sh workspaces/incubator/build-candidates.sh render-3d-studio

# Requiert un commit réel du modèle HF dont la licence est acceptée :
MODEL_REPO=HuggingFaceTB/SmolLM2-135M-Instruct \
 MODEL_COMMIT=<commit-HF-40-caracteres-verifie> \
 sh workspaces/incubator/build-candidates.sh llm-studio

# Requiert lien officiel Mojang et SHA256 du jar, revus manuellement :
MOJANG_SERVER_URL=<url-officielle> MOJANG_SERVER_SHA256=<sha256-verifie> \
 sh workspaces/incubator/build-candidates.sh game-server-studio
```

Les scripts d'installation exigent un réseau sortant **au build uniquement**. Une fois construites,
les sessions doivent rester isolées et utiliser le GPU réservé exact, sans accès Internet direct
ni port hôte exposé par le conteneur locataire. Pour ComfyUI, modèle et custom nodes doivent
être figés et audités ; ne jamais laisser un locataire injecter de custom nodes non approuvés.

### Vérifications réalisées automatiquement

```sh
python3 workspaces/incubator/test_sources.py
sh -n workspaces/incubator/build-candidates.sh
# Les tests TypeScript d'API s'exécutent via le CI standard.
```

Ces tests prouvent seulement le **code, la syntaxe et le verrouillage non réservable**.
Ils ne constituent ni une installation sur une RTX physique, ni une qualification de bout en
bout. Il manque notamment la construction Docker réelle, la publication d'images par digest,
le lancement Agent + Gateway, le calcul GPU, le premier résultat client, la préemption du
mineur GPU et le nettoyage sur deux machines physiques.

**État contractuel inchangé :** 9 Workspaces historiques qualifiés ; 4 historiques bloqués ;
6 nouveaux logiciels Docker définis dans le dépôt mais **non qualifiés / non réservables**.
