# Workspace Engine

## Modèle

- `WorkspaceDefinition` : slug, version, catégorie, release et manifeste JSON.
- `MachineWorkspace` : analyse d’une machine, score, état, activation,
  configuration, prix et dernier test.
- `WorkspaceSession` : prévu en phase cycle de vie, non créé tant que les
  garanties de démarrage, arrêt et nettoyage ne sont pas implémentées.

Les manifestes TypeScript sont la source versionnée. L’analyse les synchronise
en base afin que les choix machine restent reliés à une définition durable.

## Compatibilité

Le moteur donne un score de 0 à 100 et deux listes explicables :
`reasons` et `missing`. Les critères actuellement mesurables sont RAM, disque,
VRAM, CUDA, Docker, runtime NVIDIA et virtualisation. Réseau, encodeurs,
benchmarks et fiabilité seront ajoutés seulement après une mesure fiable.

Les règles restent dans `workspace-compatibility.ts`, jamais dans les cartes
frontend. Un nouvel espace s’ajoute par manifeste et tests, pas par duplication
de composants.

## API de fondation

- `GET /workspaces` et `GET /workspaces/:slug` : catalogue public ;
- `POST /machines/:id/workspaces/analyze` : propriétaire uniquement ;
- `GET /machines/:id/workspaces/manage` : configuration privée ;
- `PATCH /machines/:id/workspaces/:slug` : activation et limites validées ;
- `GET /machines/:id/workspaces` : espaces activés d’une machine publiée.

L’API refuse actuellement l’activation de tout espace autre que `compute`.
