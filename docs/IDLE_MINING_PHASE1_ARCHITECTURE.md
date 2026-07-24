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

## Architecture cible pour un mineur réel

Un mineur réel ne devra jamais être lancé directement par l'interface Tauri. La cible est une chaîne de confiance séparée :

```text
Interface non privilégiée
        |
        v
Service hôte signé
        |
        v
Catalogue local de mineurs approuvés
        |
        v
Adaptateur signé + binaire épinglé par SHA-256
        |
        v
Processus isolé, ressources limitées, réseau filtré
```

Règles obligatoires :

- catalogue signé et versionné, sans URL arbitraire fournie par l'API ;
- binaires téléchargés uniquement depuis des origines allowlistées, puis vérifiés par hash et signature ;
- aucun lancement via shell ; arguments construits depuis des champs typés et allowlistés ;
- exécution sous un compte système dédié sans privilèges administrateur ;
- répertoire de travail jetable et aucun accès aux documents personnels ;
- limites CPU, mémoire, GPU, température et puissance appliquées localement ;
- connexions réseau limitées aux pools explicitement approuvées ;
- watchdog local indépendant de l'interface et du backend ;
- arrêt forcé borné dans le temps avant toute location ;
- quarantaine persistante si l'identité du processus, du binaire ou du GPU change ;
- journal d'audit local signé, sans clé de portefeuille privée ;
- mise à jour atomique avec possibilité de retour à la version précédente ;
- télémétrie minimale, consentie et sans données personnelles.

## Séparation des secrets

L'application ne doit stocker qu'une adresse publique de paiement et une configuration non sensible. Les secrets éventuels d'une pool doivent être placés dans le coffre natif du système, accessibles uniquement au service signé et jamais renvoyés au frontend, aux logs ou à l'API générale.

Aucune seed phrase, clé privée de portefeuille ou commande de pool ne doit transiter dans GPUbnb Host.

## Politique de priorité et de sûreté

La location garde une priorité absolue. Une réservation entraîne immédiatement :

1. interdiction de tout nouveau démarrage du mineur ;
2. demande d'arrêt gracieux ;
3. vérification indépendante de la disparition du processus ;
4. contrôle de libération GPU et VRAM ;
5. nettoyage de l'espace de travail ;
6. seulement ensuite, préparation de la location.

Tout échec bloque la location et place la ressource en quarantaine. Le système ne doit jamais supposer qu'un processus est arrêté sur la seule base d'un retour API.

## Phases futures

### Phase 2 — adaptateur simulé signé

- interface `MinerAdapter` stable ;
- manifeste signé de test ;
- watchdog, journal d'audit et limites de ressources simulés ;
- tests de reprise après crash et redémarrage machine.

### Phase 3 — binaire de test contrôlé

- binaire interne inoffensif servant de faux mineur ;
- vérification hash/signature ;
- sandbox OS réelle ;
- tests d'arrêt forcé, changement de GPU et corruption du manifeste.

### Phase 4 — mineur réel limité

- un seul mineur et une seule cryptomonnaie initialement ;
- pool externe allowlistée ;
- activation locale explicite ;
- canary limité et télémétrie de sûreté ;
- audit indépendant du binaire exact et de la chaîne de mise à jour.

### Phase 5 — catalogue extensible

- plusieurs algorithmes via adaptateurs signés ;
- sélection basée sur compatibilité, coût énergétique et règles locales ;
- aucune optimisation automatique non bornée ;
- révocation rapide d'une version compromise.

## Critères avant activation réelle

Le minage réel reste interdit tant que les éléments suivants ne sont pas prouvés :

- signatures de code et chaîne de mise à jour opérationnelles ;
- sandbox certifiée sur Windows, macOS et Linux ;
- arrêt et libération GPU testés sous panne et charge ;
- protection thermique et électrique validée sur matériel réel ;
- revue sécurité indépendante ;
- politique légale et énergétique documentée ;
- procédure de révocation et de réponse à incident testée ;
- consentement propriétaire clair et révocable.

## Étapes suivantes

1. Relier `ResourceController` et `MiningSupervisor` à l'état Tauri partagé.
2. Ajouter des commandes Tauri de lecture, activation, désactivation et arrêt d'urgence.
3. Ajouter l'interface propriétaire, désactivée par défaut.
4. Persister uniquement une configuration validée et non sensible.
5. Ajouter des métriques GPU simulées et un journal local signé.
6. Introduire un `MinerAdapter` simulé signé.
7. Tester les crashs, redémarrages et quarantaines sur les trois OS.
8. Après validation complète seulement, tester un binaire interne inoffensif épinglé par hash.
9. N'envisager un mineur réel qu'après audit et certification de la chaîne complète.

## Hors périmètre de cette phase

- pool GPUbnb ;
- frais de pool ;
- paiements ;
- téléchargement de mineurs réels ;
- optimisation automatique ;
- multi-cryptomonnaies réel ;
- exécution de commandes système fournies par l'API ou l'utilisateur.
