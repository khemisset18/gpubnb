# GPUbnb — Installation bêta privée

Toutes les commandes de ce document proviennent de code et de fichiers de configuration existants et vérifiés (`README.md`, `docs/AGENT.md`, `docker-compose.yml`/`infra/docker-compose.yml`, `apps/api/package.json`, `render.yaml`, workflows CI). **Aucune installation « propre depuis zéro » sur une vraie machine Windows n'a été exécutée dans le cadre de cette tâche** — la seule preuve indirecte disponible est le pipeline CI `publish-host-test-release.yml`, qui construit et exécute un contrôle de démarrage (`gpubnb-agent.exe version`, `gpubnb-agent.exe runtime-check`) sur un runner Windows propre à chaque exécution, et a réussi sur le commit de fusion de la PR #44 (`a2d334c`, 2026-08-07). Ce n'est pas équivalent à une installation manuelle par un humain sur son propre poste — ce dernier test reste à faire (voir `BETA_PRIVATE_TEST_PLAN.md`, scénario 10).

## 1. Infrastructure API (opérateur GPUbnb uniquement)

### 1.1 Local / développement

```bash
cp .env.example .env
# Éditer .env : remplacer tous les CHANGE_ME_* par des secrets générés (32+ octets aléatoires).
docker compose -f infra/docker-compose.yml up -d
cd apps/api
npm ci
npx prisma generate
npx prisma migrate deploy
npm test
npm run build
npm start
```

Dans un second terminal — **obligatoire**, sans quoi aucune réservation ne dépasse `AWAITING_DEPOSIT` :

```bash
cd apps/api
npm run dev:delivery   # ou : npm run start:delivery après build
```

Dans un troisième terminal — **nouveau dans cette branche, obligatoire pour que les machines hors-ligne et les jobs bloqués soient réconciliés automatiquement** :

```bash
cd apps/api
npm run dev:sweep      # ou : npm run start:sweep après build
```

### 1.2 Production (Render)

`render.yaml` déclare désormais trois services (`gpubnb` API, `gpubnb-delivery-worker`, `gpubnb-sweep-scheduler`, ce dernier ajouté en Priorité 3 de cette branche). Un déploiement Render à partir de ce fichier crée les trois automatiquement — aucune étape manuelle supplémentaire needed pour le sweep planifié. Vérifier après déploiement :

```bash
curl -s https://<host>/health
curl -s https://<host>/ready
```

Variables d'environnement à provisionner manuellement (`sync:false` dans `render.yaml`, jamais commitées) : `DATABASE_URL`, `REDIS_URL`. Les secrets (`SESSION_SECRET`, `INTERNAL_SERVICE_TOKEN`) sont générés automatiquement par Render (`generateValue:true`).

## 2. Agent hôte — installation développeur (CLI Python)

Prérequis : Windows 10/11 ou Ubuntu récent, Python 3.10+, pilote NVIDIA (`nvidia-smi` fonctionnel), Docker + NVIDIA Container Toolkit (requis pour `GPU_DIAGNOSTIC`/`GPU_PROOF`/`WORKSPACE_PREPARE`, vérifiés par `diagnose`).

```bash
python -m pip install -e agent
gpubnb-agent setup
gpubnb-agent diagnose
```

Sous PowerShell, utiliser `py -m pip` si `python` n'est pas résolu.

Liaison à un compte (voir `docs/AGENT.md` pour le détail de chaque commande) :

```bash
gpubnb-agent link CODE_TEMPORAIRE
gpubnb-agent start --daemon
gpubnb-agent status
gpubnb-agent logs
```

Le code de liaison expire après dix minutes et ne peut servir qu'une fois. La clé Ed25519 privée reste locale (`%PROGRAMDATA%\GPUbnb` sous Windows, ACL restreinte au compte d'installation, aux administrateurs locaux et à `SYSTEM` ; `${XDG_CONFIG_HOME:-~/.config}/gpubnb` sous Linux) — elle n'est jamais transmise à l'API.

**Nouveau dans cette branche :** le verrou d'instance unique (`agent.lock`) est acquis automatiquement par `start`, `start --daemon` et le service Windows — aucune action opérateur nécessaire, mais si un second `gpubnb-agent start` est tenté sur la même machine pendant que le premier tourne, il échoue proprement avec le PID du détenteur réel plutôt que de créer une seconde instance concurrente.

## 3. Agent hôte — application `GPUbnb Host` (Tauri, Windows)

`apps/host-desktop` fournit une interface graphique qui pilote le même agent CLI en sous-processus (`agent_bridge.rs`). Deux formes d'installation existent, produites par CI (`publish-host-test-release.yml`) :

- **Portable** : `GPUbnb-Host-Portable.exe` + `gpubnb-agent.exe` (sidecar) dans le même dossier — aucune installation système, exécution directe.
- **Installateur** : `gpubnb-host-windows-x64.exe` (bundle Tauri complet).

**Ce chemin d'installation n'a jamais été utilisé comme rôle hôte réel dans une location GPU de bout en bout** (`KNOWN_LIMITATIONS_RC1.md`, non affecté par cette branche). Avant d'inviter un hôte bêta à installer uniquement l'application graphique (sans jamais toucher à une console), ce parcours doit être rejoué intégralement — voir `BETA_PRIVATE_TEST_PLAN.md`, scénario 10.

## 4. Vérification post-installation (les deux formes)

```bash
gpubnb-agent version
gpubnb-agent diagnose
gpubnb-agent status
```

`status` doit rapporter le PID réel du détenteur du verrou d'instance (Priorité 1) — si un PID est rapporté mais qu'aucun agent ne semble tourner, ne jamais supprimer manuellement les fichiers de verrou (`agent.lock`, `agent.pid`) sans avoir d'abord confirmé qu'aucun processus ne le détient réellement (`tasklist`/`ps`) : le verrou est auto-nettoyé par le système d'exploitation à la fin de tout processus, y compris un arrêt brutal — un verrou visiblement bloqué signifie presque toujours qu'un processus le détient encore.

## 5. Non couvert par ce document

- Déploiement du programme Solana `gpu_escrow` (jamais fait, voir `BETA_PRIVATE_READINESS.md` section 2).
- Configuration DNS/certificats pour un domaine de production dédié à la bêta.
- Provisionnement d'un service Postgres/Redis managé distinct de Render (si un autre hébergeur est choisi).
