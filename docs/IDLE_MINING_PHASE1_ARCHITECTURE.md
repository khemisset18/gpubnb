# GPUbnb Idle Mining — architecture Phase 1

## Statut

Cette phase fournit uniquement une orchestration simulée. Elle ne télécharge, n'installe et n'exécute aucun logiciel de minage réel.

Le minage reste désactivé par défaut et la location GPUbnb conserve toujours la priorité absolue.

## Éléments déjà présents dans le dépôt

Le client hôte possède une machine d'états `ResourceController` dans :

```text
apps/host-desktop/src-tauri/src/resource_state.rs
```

Elle modélise actuellement :

```text
OFFLINE
IDLE
MINING
STOPPING_MINER
PREPARING_RENTAL
RENTAL
CLEANING
EMERGENCY_STOPPED
```

Elle interdit notamment :

- le démarrage de la location avant l'arrêt confirmé du mineur ;
- la reprise du minage avant la vérification du nettoyage ;
- une transition directe de `MINING` vers `RENTAL` ;
- le maintien d'une réservation après un arrêt d'urgence ou une invalidation de sécurité.

## Nouveau Mining Supervisor simulé

Le fichier suivant constitue la première fondation :

```text
apps/host-desktop/src-tauri/src/mining_supervisor.rs
```

Responsabilités :

- valider une configuration approuvée ;
- exiger un consentement local explicite ;
- vérifier que le GPU est libre ;
- refuser le démarrage lorsqu'une réservation est en attente ;
- simuler le cycle `STOPPED -> STARTING -> RUNNING` ;
- arrêter le mineur avant une location ;
- mettre le GPU en quarantaine si le processus ne peut pas être arrêté ;
- confirmer que le GPU est entièrement libéré.

Le superviseur n'accepte actuellement aucune URL, commande shell, option libre ou chemin de binaire.

## Flux prioritaire

```text
Propriétaire active le minage
        |
        v
Validation locale + GPU libre
        |
        v
MINING
        |
        | réservation reçue
        v
STOPPING_MINER
        |
        +-- arrêt confirmé --> PREPARING_RENTAL --> RENTAL
        |
        +-- arrêt échoué ----> QUARANTINED (location bloquée)
```

Après une location :

```text
RENTAL -> CLEANING -> CLEANUP_VERIFIED -> IDLE ou MINING
```

Le retour vers `MINING` dépend toujours du choix conservé du propriétaire.

## Garanties de sécurité Phase 1

- aucune clé privée ou seed phrase ;
- aucune exécution distante arbitraire ;
- aucun argument utilisateur transmis à un shell ;
- identifiants, version, worker et limites validés ;
- limites de température et de puissance obligatoires ;
- verrou logique empêchant `MINING + RENTAL` ;
- mise en quarantaine en cas d'arrêt incomplet ;
- contrôle local prioritaire ;
- fonctionnement simulé uniquement.

## Tests ajoutés

```text
apps/host-desktop/src-tauri/tests/idle_mining_phase1.rs
```

Scénarios couverts :

1. passage complet du minage simulé vers une location ;
2. interdiction de démarrer la location avant libération du GPU ;
3. quarantaine lorsque le mineur ne s'arrête pas ;
4. reprise du minage uniquement après nettoyage vérifié ;
5. rejet d'une configuration contenant des arguments dangereux ;
6. refus sans consentement local ;
7. refus si une réservation est déjà en attente.

## Étapes suivantes

1. Relier `ResourceController` et `MiningSupervisor` à l'état Tauri partagé.
2. Ajouter des commandes Tauri de lecture, activation, désactivation et arrêt d'urgence.
3. Ajouter l'interface propriétaire, désactivée par défaut.
4. Persister uniquement une configuration validée et non sensible.
5. Ajouter des métriques GPU simulées et un journal local signé.
6. Exécuter les tests Windows et Linux dans GitHub Actions.
7. Introduire un `MinerAdapter` simulé signé.
8. Après validation complète seulement, tester un mineur réel épinglé par hash avec une pool externe.

## Hors périmètre de cette phase

- pool GPUbnb ;
- frais de pool ;
- paiements ;
- téléchargement de mineurs ;
- optimisation automatique ;
- multi-cryptomonnaies réel ;
- exécution de commandes système fournies par l'API ou l'utilisateur.
