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
