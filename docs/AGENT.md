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
gpubnb-agent version
```

## Données locales

- Windows : `%LOCALAPPDATA%\GPUbnb`
- Linux : `${XDG_CONFIG_HOME:-~/.config}/gpubnb`

La clé privée `agent.key` reste dans ce dossier. Elle n'est jamais envoyée à
GPUbnb ni affichée par les commandes. Sauvegardez-la comme un secret local.

`reset-key --yes` supprime la liaison logique. La révocation serveur complète
sera ajoutée dans la Phase 2 sécurité.

