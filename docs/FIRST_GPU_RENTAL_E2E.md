# Premier test de location GPU de bout en bout

Ce guide valide une réservation réelle entre deux machines en environnement de développement :

- **Machine propriétaire** : Linux ou Windows avec Docker, NVIDIA Container Toolkit, pilote NVIDIA et un GPU NVIDIA.
- **Machine locataire** : navigateur Web et accès à l'API de développement.
- **Serveur de développement** : PostgreSQL, Redis, API et Delivery Worker.

Le mode de paiement bypass est interdit en production par validation de configuration.

## 1. Prérequis

Sur la machine propriétaire :

```bash
nvidia-smi
docker version
docker info
```

Valider le passthrough NVIDIA avant GPUbnb :

```bash
docker run --rm --gpus all nvidia/cuda:12.8.1-base-ubuntu24.04 nvidia-smi
```

Cette commande doit afficher le même GPU que `nvidia-smi` sur l'hôte.

## 2. Référence de l'image officielle

Récupérer l'artefact `gpu-diagnostic-image-evidence` du workflow `gpu-diagnostic-image` sur `main`, puis lire :

```text
gpu-diagnostic-image.txt
```

La valeur doit respecter exactement :

```text
ghcr.io/khemisset18/gpu-diagnostic@sha256:<64 caractères hexadécimaux>
```

Ne jamais utiliser `latest` dans l'agent.

Tester l'image officielle directement sur la machine propriétaire :

```bash
export GPU_DIAGNOSTIC_IMAGE='ghcr.io/khemisset18/gpu-diagnostic@sha256:...'
docker pull "$GPU_DIAGNOSTIC_IMAGE"
docker run --rm \
  --gpus device=0 \
  --env NVIDIA_DRIVER_CAPABILITIES=utility \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 32 \
  --memory 128m \
  --cpus 0.5 \
  "$GPU_DIAGNOSTIC_IMAGE"
```

La sortie attendue est un objet JSON avec `schemaVersion: 1`, `vendor: NVIDIA`, `gpuCount` et `gpus`.

## 3. Démarrer les services

Depuis la racine du dépôt :

```bash
docker compose up -d postgres redis
```

Configurer l'API dans `apps/api/.env` :

```dotenv
NODE_ENV=development
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
SESSION_SECRET=<au moins 32 caractères>
INTERNAL_SERVICE_TOKEN=<au moins 32 caractères>
PUBLIC_APP_DOMAIN=localhost
PLATFORM_WALLET=<clé publique Solana valide>
ESCROW_PROGRAM_ID=NOT_DEPLOYED_YET
DEV_PAYMENT_BYPASS=true
DEV_DIAGNOSTIC_IMAGE=ghcr.io/khemisset18/gpu-diagnostic@sha256:...
```

Le bypass doit rester `false` ou absent hors développement.

Installer et migrer :

```bash
cd apps/api
npm ci
npx prisma generate
npx prisma migrate deploy
```

Terminal API :

```bash
npm run dev
```

Terminal Delivery Worker :

```bash
npm run dev:delivery
```

Vérifier les services :

```bash
curl -fsS http://localhost:8787/health
curl -fsS http://localhost:8787/ready
redis-cli -u "$REDIS_URL" ping
```

`/ready` doit retourner `{"ok":true}`. Le worker doit journaliser `delivery_worker_started` puis `delivery_worker_health`.

## 4. Configurer la machine propriétaire

Installer l'agent puis :

```bash
gpubnb-agent setup \
  --api-url http://<IP_SERVEUR>:8787 \
  --diagnostic-image "$GPU_DIAGNOSTIC_IMAGE"
```

Dans le compte propriétaire, créer un code de liaison, puis :

```bash
gpubnb-agent link <CODE>
gpubnb-agent diagnose
gpubnb-agent start
```

Le diagnostic doit indiquer :

- clé présente ;
- machine liée ;
- API accessible ;
- GPU détecté ;
- Docker disponible ;
- runtime NVIDIA disponible.

Attendre que la machine soit `ONLINE`, `AVAILABLE`, vérifiée, puis créer une annonce active.

## 5. Créer la réservation locataire

Depuis le site de développement :

1. Se connecter avec un compte différent du propriétaire.
2. Ouvrir l'annonce du GPU.
3. Créer une réservation commençant dans moins de cinq minutes.
4. Confirmer la réservation.

Avec `DEV_PAYMENT_BYPASS=true`, le Delivery Worker réalise automatiquement et de manière idempotente :

1. `AWAITING_DEPOSIT → FUNDED` ;
2. création du paiement de test `ESCROW_FUNDED` ;
3. `FUNDED → STARTING` ;
4. création d'un unique job `GPU_DIAGNOSTIC` ;
5. réservation de la machine.

## 6. Exécution automatique attendue

L'agent :

1. réclame le prochain job signé ;
2. valide le type `GPU_DIAGNOSTIC` ;
3. vérifie l'image officielle épinglée ;
4. exécute explicitement `docker pull` ;
5. crée un nom de conteneur unique ;
6. démarre le conteneur sans réseau et en lecture seule ;
7. capture stdout/stderr avec limites ;
8. valide strictement le JSON ;
9. envoie le résultat à l'API ;
10. supprime le conteneur dans un bloc `finally`.

Le Delivery Worker observe ensuite le job terminal :

- succès avec `gpuDetected=true` : réservation `COMPLETED`, machine `AVAILABLE` ;
- échec, timeout, rejet ou quarantaine : réservation `DEGRADED`, machine `DEGRADED`.

## 7. Vérifications

Dans les journaux de l'agent, rechercher :

```text
job_completed
```

Dans le tableau de bord locataire :

- job `GPU_DIAGNOSTIC` : `COMPLETED` ;
- résultat : `gpuDetected=true` ;
- réservation : `COMPLETED`.

Sur la machine propriétaire :

```bash
docker ps -a --filter 'name=gpubnb-diagnostic-'
```

La commande ne doit retourner aucun conteneur résiduel.

Dans PostgreSQL, vérifier qu'il existe exactement un job diagnostic pour la réservation :

```sql
SELECT "bookingId", type, status, count(*)
FROM "Job"
WHERE type = 'GPU_DIAGNOSTIC'
GROUP BY "bookingId", type, status;
```

## 8. Test de répétition

Exécuter le scénario au moins trois fois avec trois nouvelles réservations.

Critères obligatoires à chaque passage :

- aucun double job ;
- aucun conteneur résiduel ;
- résultat GPU cohérent ;
- réservation terminée ;
- machine revenue disponible ;
- API `/ready` verte ;
- worker vivant ;
- aucun secret dans les logs.

## 9. Incidents

### Le GPU n'apparaît pas

Rejouer la commande CUDA `nvidia-smi`, puis vérifier NVIDIA Container Toolkit et `docker info`.

### Aucun job n'arrive

Vérifier :

- agent lié à la bonne machine ;
- heartbeat actif ;
- réservation dans les cinq minutes ;
- worker démarré ;
- `DEV_PAYMENT_BYPASS=true` ;
- machine `ONLINE`, Docker et runtime NVIDIA disponibles.

### Le pull GHCR échoue

Vérifier le digest, la visibilité du package et une éventuelle authentification `docker login ghcr.io`.

### La réservation reste STARTING

Consulter le job associé, les logs agent et l'état du conteneur. Un job terminal en échec doit faire passer la réservation en `DEGRADED` au prochain cycle du worker.

## 10. Sécurité

- Ne jamais activer `DEV_PAYMENT_BYPASS` en production ; l'API refuse de démarrer dans ce cas.
- Ne jamais utiliser une image non épinglée.
- Ne jamais désactiver les contrôles Docker pour faire passer un test.
- Ne jamais exposer PostgreSQL ou Redis publiquement.
- Utiliser des secrets distincts et longs pour chaque environnement.
