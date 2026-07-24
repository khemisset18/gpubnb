# GPUbnb Agent 0.5

## Prérequis

- Windows 10/11 ou Ubuntu récent.
- Python 3.10 ou supérieur.
- Pilote NVIDIA avec `nvidia-smi`.
- Docker et NVIDIA Container Toolkit seront obligatoires pour les tâches de la
  Phase 3 ; ils sont déjà contrôlés par `diagnose`.

## Installation développeur

```bash
python -m pip install -e agent
gpubnb-agent setup
```

Sous Windows PowerShell, utilisez `py -m pip` si la commande `python` n'existe
pas.

## Liaison

1. Connectez-vous à `https://gpubnb.netlify.app/dashboard.html`.
2. Activez le rôle loueur dans votre profil.
3. Dans « Lier GPUbnb Agent », créez un code.
4. Sur le PC GPU :

```bash
gpubnb-agent link VOTRECODE
gpubnb-agent diagnose
gpubnb-agent start
```

Le code expire après dix minutes et ne peut servir qu'une fois.

## Commandes

```text
gpubnb-agent setup
gpubnb-agent login
gpubnb-agent link CODE
gpubnb-agent start
gpubnb-agent start --daemon
gpubnb-agent stop
gpubnb-agent status
gpubnb-agent diagnose
gpubnb-agent show-key
gpubnb-agent reset-key --yes
gpubnb-agent benchmark
gpubnb-agent logs
gpubnb-agent simulate
gpubnb-agent version
```

## Simulateur GPU (tests sans vrai GPU)

`gpubnb-agent simulate` génère des machines GPU factices pour tester le site et
le tableau de bord sans posséder de vrai matériel. Chaque machine simulée a sa
propre identité Ed25519 et utilise exactement le même protocole signé
(liaison → challenge → heartbeat) que l'agent réel : la chaîne de sécurité du
serveur (signatures, compteur anti-rejeu, cohérence des métriques) est donc
exercée de bout en bout.

Deux modes :

- **Hors-ligne** (par défaut) : fait évoluer des métriques réalistes et les
  affiche en JSON. Aucun réseau requis.

  ```bash
  gpubnb-agent simulate --count 5 --scenario mixed --steps 20 --seed 1
  ```

- **Live** : lie chaque machine avec un code à usage unique puis envoie des
  heartbeats signés à une API en cours d'exécution.

  ```bash
  gpubnb-agent simulate --api-url http://localhost:8787 --codes CODE1,CODE2 \
    --scenario steady --steps 10 --interval 5
  ```

Scénarios disponibles : `steady`, `idle`, `spike`, `overheat`, `failure`,
`flapping`, `mixed`. La graine `--seed` rend chaque simulation reproductible.
Le catalogue couvre plusieurs modèles NVIDIA, AMD et Intel avec VRAM,
température, puissance et pannes/déconnexions simulées.

## Données locales

- Windows : `%LOCALAPPDATA%\GPUbnb`
- Linux : `${XDG_CONFIG_HOME:-~/.config}/gpubnb`

La clé privée `agent.key` reste dans ce dossier. Elle n'est jamais envoyée à
GPUbnb ni affichée par les commandes. Sauvegardez-la comme un secret local.

`reset-key --yes` supprime la liaison logique. La révocation serveur complète
sera ajoutée dans la Phase 2 sécurité.

