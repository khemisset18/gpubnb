# Image GPU Diagnostic officielle

Cette image exécute uniquement un diagnostic NVIDIA via NVML. L’image finale est Distroless, s’exécute avec l’utilisateur non privilégié `65532`, et ne contient ni shell, ni gestionnaire de paquets, ni service réseau.

## Contrat d’exécution

L’entrypoint écrit un unique document JSON sur stdout :

```json
{
  "schemaVersion": 1,
  "vendor": "NVIDIA",
  "gpuCount": 1,
  "gpus": [
    {
      "index": 0,
      "name": "NVIDIA GeForce RTX 4090",
      "uuid": "GPU-...",
      "memoryTotalMiB": 24564,
      "memoryUsedMiB": 512,
      "temperatureC": 45
    }
  ]
}
```

Le binaire charge `libnvidia-ml.so.1` à l’exécution. Cette bibliothèque est injectée depuis l’hôte par NVIDIA Container Toolkit avec la capacité `utility`. Aucun pilote NVIDIA n’est embarqué dans l’image.

## Construction locale

```bash
docker build -t gpu-diagnostic:local containers/gpu-diagnostic
```

Le test matériel exige un hôte NVIDIA correctement configuré :

```bash
docker run --rm \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=32 \
  --memory=128m \
  --cpus=0.5 \
  --gpus=device=0 \
  --env=NVIDIA_DRIVER_CAPABILITIES=utility \
  gpu-diagnostic:local
```

## Publication officielle

Le workflow `gpu-diagnostic-image` :

1. construit l’image ;
2. vérifie que le runtime ne contient pas `/bin/sh` ;
3. bloque sur les vulnérabilités HIGH ou CRITICAL corrigibles ;
4. produit un SBOM SPDX ;
5. publie `ghcr.io/khemisset18/gpu-diagnostic` ;
6. signe le digest avec Cosign en mode keyless ;
7. publie le digest exact dans le résumé GitHub Actions et dans l’artefact `gpu-diagnostic-image-evidence`.

La publication est déclenchée sur `main`, sur un tag `gpu-diagnostic-v*`, ou manuellement.

## Configuration de l’agent

Ne jamais utiliser `latest` dans la configuration. Copier la référence immuable produite par le workflow :

```text
ghcr.io/khemisset18/gpu-diagnostic@sha256:<digest-publié>
```

Puis configurer l’agent :

```bash
gpubnb-agent setup \
  --diagnostic-image ghcr.io/khemisset18/gpu-diagnostic@sha256:<digest-publié>
```

L’agent refuse :

- une image non épinglée par digest ;
- une image provenant d’un autre dépôt ;
- l’utilisation de cette image NVIDIA sur une machine AMD ou Intel.

## Vérification de signature

```bash
cosign verify \
  ghcr.io/khemisset18/gpu-diagnostic@sha256:<digest-publié> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp 'https://github.com/khemisset18/gpubnb/.github/workflows/gpu-diagnostic-image.yml@refs/(heads/main|tags/gpu-diagnostic-v.*)'
```

## Limites du MVP

Cette image officielle couvre NVIDIA uniquement. AMD ROCm et Intel XPU doivent disposer d’images officielles séparées, avec leurs propres outils, scans, signatures et allowlists de registre.
