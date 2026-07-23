# Test GPUbnb entre deux PC

État actuel : parcours de liaison et heartbeat testable. La tâche
`GPU_DIAGNOSTIC` distante sera ajoutée en Phase 3 ; elle n'est pas présentée
comme fonctionnelle ici.

## PC A — propriétaire du GPU

1. Installer Python 3.10+, le pilote NVIDIA et vérifier :

   ```bash
   nvidia-smi
   ```

2. Cloner le dépôt puis installer l'agent :

   ```bash
   python -m pip install -e agent
   gpubnb-agent setup
   ```

3. Vérifier que le rapport trouve exactement un GPU :

   ```bash
   gpubnb-agent diagnose
   ```

## PC B — compte loueur

1. Ouvrir `https://gpubnb.netlify.app/auth.html`.
2. Se connecter et finaliser le profil.
3. Activer « Loueur ».
4. Ouvrir le tableau de bord, espace loueur.
5. Cliquer « Créer un code de liaison ».
6. Communiquer uniquement ce code temporaire au PC A.

## PC A — liaison et heartbeat

```bash
gpubnb-agent link CODE_RECU
gpubnb-agent status
gpubnb-agent start
```

Résultat attendu :

- `link` renvoie un identifiant machine ;
- `start` affiche des événements `heartbeat` réussis ;
- la machine apparaît en ligne dans le tableau de bord du PC B ;
- l'arrêt de l'agent rend la machine hors ligne après le délai serveur ;
- son redémarrage la remet en ligne après un heartbeat valide.

Pour un lancement en arrière-plan :

```bash
gpubnb-agent start --daemon
gpubnb-agent logs
gpubnb-agent stop
```

## PC B — vérification

1. Recharger l'espace loueur.
2. Vérifier GPU, statut et dernière preuve.
3. Publier une annonce seulement après une preuve valide.

## Limites du test Phase 1

- Aucun code utilisateur n'est exécuté.
- Aucun paiement réel n'est effectué.
- Le contrat Solana reste non déployé.
- Le test de tâche Docker GPU sera ajouté sans accès privilégié en Phase 3.

