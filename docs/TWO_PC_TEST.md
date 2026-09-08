# Test physique GPUbnb entre deux PC — release actuelle

Ce document est la procédure opératoire pour exécuter la qualification décrite dans `docs/CURRENT_PHYSICAL_QUALIFICATION.md`.

**Statut actuel : la qualification PC A ↔ PC B de la release actuelle n'est pas encore passée.** Un ancien test, un simulateur, une exécution localhost ou un ancien `GPU_DIAGNOSTIC` ne remplace pas ce run.

## Rôles

- **PC A — Host** : machine propriétaire du GPU NVIDIA réel, Agent de release, Docker + NVIDIA runtime.
- **PC B — Renter** : machine distincte, navigateur/session locataire distincts de PC A.
- Le run final utilise le frontend, l'API et le workspace gateway publics de la release. Aucun raccourci localhost ne compte.
- Utiliser uniquement le mode de paiement privé/devnet approuvé pour la release. Ce protocole n'autorise ni Mainnet ni argent réel.

## 0. Geler l'identité de release

Après fusion de tous les changements pré-test, mettre les deux PC sur la release à qualifier et noter le SHA exact :

```powershell
git fetch origin
git checkout main
git pull --ff-only
git rev-parse HEAD
```

Appeler cette valeur `<RELEASE_SHA>`. **Ne plus modifier ni mettre à jour un composant exécutable pendant le clean run.** Si l'API, le frontend, le gateway ou l'Agent change, recommencer la qualification avec une nouvelle identité de release.

Noter également sans secret : classe Redis, classe PostgreSQL, origines frontend/API/gateway réellement utilisées.

## 1. PC A — préflight Host en une commande

Depuis la racine du dépôt :

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\qualification-preflight-pc-a.ps1 `
  -ExpectedReleaseCommit <RELEASE_SHA>
```

Sur une machine multi-GPU, verrouiller explicitement la cible :

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\qualification-preflight-pc-a.ps1 `
  -ExpectedReleaseCommit <RELEASE_SHA> `
  -ExpectedGpuUuid GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Pour verrouiller aussi un build Agent attendu :

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\qualification-preflight-pc-a.ps1 `
  -ExpectedReleaseCommit <RELEASE_SHA> `
  -ExpectedAgentCommit <AGENT_BUILD_SHA>
```

Le préflight échoue si notamment : dépôt ambigu/non propre, Agent non gelé ou non lié/en cours d'exécution, `runtime-check`/`diagnose` en échec, Docker indisponible, GPU NVIDIA introuvable, UUID cible absent, ou ancien container/proxy/volume/réseau GPUbnb par session encore présent.

Le résultat non secret est écrit dans `qualification-evidence/pc-a-preflight-*.json`.

## 2. PC B — préflight du vrai chemin public

Depuis la même release du dépôt sur PC B :

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\qualification-preflight-pc-b.ps1 `
  -FrontendOrigin https://<frontend-public> `
  -ApiOrigin https://<api-public> `
  -GatewayOrigin https://<gateway-public> `
  -ExpectedReleaseCommit <RELEASE_SHA>
```

Ce préflight exige HTTPS et vérifie :

- le frontend public ;
- le proxy same-origin `https://<frontend>/api/ready` ;
- l'API publique `/ready` ;
- le gateway public `/ws-health` avec `gpubnb-ws-ok` ;
- le `config.js` réellement publié (`/api`, gateway configuré, commit frontend non-local) ;
- la correspondance du commit frontend publié avec `<RELEASE_SHA>`.

Le résultat non secret est écrit dans `qualification-evidence/pc-b-preflight-*.json`.

**Ne pas lancer la réservation si un des deux préflights échoue.**

## 3. Ouvrir le dossier d'évidence et verrouiller le run

Copier le JSON du préflight PC B vers PC A, puis sur PC A :

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\qualification-evidence.ps1 `
  -Action Start `
  -PcAPreflightPath .\qualification-evidence\pc-a-preflight-<timestamp>.json `
  -PcBPreflightPath .\qualification-evidence\pc-b-preflight-<timestamp>.json `
  -RedisClass "<provider/endpoint class sans URL ni credential>" `
  -PostgresClass "<target class sans URL ni credential>"
```

Le collecteur refuse de démarrer si les deux préflights ne sont pas PASS ou si les identités PC A / frontend ne correspondent pas. Il crée `qualification-evidence/run-<UTC>/` avec `release-lock.json`, `qualification-run.json`, les deux préflights et `RESULT.md`.

## 4. Clean run PC A ↔ PC B

Exécuter un seul cycle cohérent sans mutation manuelle de DB/API :

1. PC A reste online avec heartbeat frais, Docker/NVIDIA sains et GPU/listing disponibles.
2. PC B se connecte avec son compte locataire distinct et réserve le vrai GPU de PC A pour une courte fenêtre contrôlée.
3. Vérifier que le serveur alloue l'accélérateur exact et que la réservation atteint l'état funded/starting attendu.
4. Laisser PC A réclamer et exécuter le vrai job `GPU_PROOF` avec son attempt/lease fenced.
5. Vérifier que `GPU_PROOF` termine sur **l'UUID physique loué**, et que son container est nettoyé.
6. Vérifier que Developer ne commence qu'après le succès de `GPU_PROOF`.
7. Vérifier qu'un seul runtime Developer et un seul gateway valides existent pour la session.
8. Sur PC B, attendre que l'UI affiche **Ouvrir mon espace** uniquement lorsque `canOpen` est vrai.
9. Cliquer **Ouvrir mon espace** et atteindre le vrai code-server via le gateway public configuré.
10. Dans le terminal code-server de PC B, exécuter :

```bash
nvidia-smi --query-gpu=uuid,name --format=csv,noheader
```

L'UUID visible doit être exactement l'UUID loué. Enregistrer une capture **sanitisée** sans cookie, token, grant ou header d'authentification.

11. Utiliser le workspace quelques minutes afin d'observer la stabilité heartbeat/gateway et le trafic authentifié normal.
12. Arrêter la location via le lifecycle normal du produit. Ne pas supprimer manuellement le container comme chemin de succès.
13. Attendre le cleanup complet : container, proxy, volume et réseau interne de session absents ; aucun orphan runtime-cleanliness.
14. Vérifier les états terminaux booking/workspace/jobs, sans stale attempt, double mutation terminale ni quarantaine inattendue.
15. Vérifier seulement après cleanup/release que le GPU et la listing redeviennent disponibles/bookables.

## 5. Finaliser la collecte d'évidence

Récupérer depuis le run : `<BOOKING_ID>`, `<GPU_PROOF_JOB_ID>`, `<WORKSPACE_SESSION_ID>`, `<MACHINE_ID>`, `<LEASED_GPU_UUID>` et au moins un correlation/request ID sanitisé utile.

Préparer également quatre fichiers sanitisés :

- une capture PNG/JPG/WEBP ou TXT de `nvidia-smi` dans code-server sur PC B ;
- une preuve GPU_PROOF liée à l'UUID loué ;
- une timeline des transitions booking/job/workspace/machine couvrant préparation, ouverture, activité et arrêt ;
- une preuve finale que le GPU et la listing sont revenus disponibles/bookables après cleanup/release.

Les trois dernières preuves peuvent être JSON, TXT ou Markdown sanitisés. Ne jamais copier de réponse brute contenant credentials, cookies, headers d'authentification, grants ou lease tokens.

Puis sur PC A :

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\qualification-evidence.ps1 `
  -Action Finish `
  -EvidenceDir .\qualification-evidence\run-<timestamp> `
  -BookingId <BOOKING_ID> `
  -GpuProofJobId <GPU_PROOF_JOB_ID> `
  -WorkspaceSessionId <WORKSPACE_SESSION_ID> `
  -MachineId <MACHINE_ID> `
  -LeasedGpuUuid <LEASED_GPU_UUID> `
  -CorrelationIds <CORRELATION_ID_1>,<CORRELATION_ID_2> `
  -PcBScreenshotPath C:\path\to\sanitized-nvidia-smi.png `
  -GpuProofEvidencePath C:\path\to\sanitized-gpu-proof.json `
  -StateTimelinePath C:\path\to\sanitized-state-timeline.json `
  -FinalAvailabilityPath C:\path\to\sanitized-final-availability.json
```

Le collecteur :

- vérifie que machine/UUID correspondent au release lock ;
- exige au moins un correlation/request ID sanitisé ;
- exige et copie les quatre preuves explicitement fournies ;
- rejette les fichiers texte/JSON/Markdown qui contiennent des marqueurs évidents de credentials/tokens ;
- dérive les noms Docker canoniques de la session ;
- échoue si un container/proxy/volume/réseau interne GPUbnb reste présent ;
- vérifie que le GPU physique cible existe encore après cleanup ;
- génère un `RESULT.md` avec checklist de décision.

**Le collecteur ne marque jamais automatiquement la release PASSED.** Les preuves serveur/UI et la capture PC B doivent encore être revues contre `CURRENT_PHYSICAL_QUALIFICATION.md`.

## 6. Décision

- Si un point obligatoire échoue : **FAILED**. Corriger la cause, produire une nouvelle release si nécessaire, puis recommencer un clean run complet.
- Si les 15 étapes et toutes les preuves obligatoires sont confirmées : créer/référencer le résultat dédié, inscrire le SHA testé et seulement alors changer le gate courant vers **PASSED**.

La campagne de fautes (coupure réseau brève, reconnexion navigateur, restart Agent, reconnexion gateway, stop répété, orphan volontaire) se fait **après** le premier clean run réussi ; elle ne le remplace jamais.

## Interdiction de secrets dans les preuves

Ne jamais enregistrer : cookies de session, `Authorization`, credentials Redis/PostgreSQL/Supabase, workspace bootstrap grants, lease tokens, clés privées ou payloads d'authentification signés complets. Les JSON produits par les scripts ne collectent volontairement que des identités de release, IDs techniques, origines publiques et état matériel/runtime non secret.
