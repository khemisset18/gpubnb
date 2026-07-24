# GPUbnb Host Desktop — orchestration GPU, minage et location

## Objectif

Documenter le comportement attendu lorsque le GPU peut être utilisé soit par un mineur local optionnel, soit par une location GPUbnb.

La location GPUbnb reste toujours prioritaire. La sécurité de l’hôte reste prioritaire sur la disponibilité commerciale.

## Principe général

1. Si le GPU est libre et que le minage est explicitement activé et configuré, le service peut lancer le mineur.
2. Lorsqu’une réservation valide arrive, le service demande l’arrêt propre du mineur.
3. Le service attend la confirmation que le processus est terminé et que le GPU est libéré.
4. Si l’arrêt échoue, dépasse le délai autorisé ou laisse le GPU occupé, la location ne démarre pas.
5. Une fois le GPU libéré, le service crée l’environnement temporaire isolé et démarre la location.
6. À la fin de la location, les accès sont révoqués et l’environnement temporaire est détruit.
7. Après une nouvelle validation locale du GPU, le mineur peut être relancé si l’utilisateur l’a autorisé.

## Machine d’état cible

- `offline` : automatisation inactive ou protection incomplète.
- `idle` : GPU libre, en attente d’une réservation.
- `mining` : mineur local actif.
- `stopping_miner` : arrêt propre demandé, aucune location autorisée.
- `rental_preparing` : GPU libre, création de l’environnement isolé.
- `rental` : location active dans l’environnement temporaire.
- `recovering` : destruction, révocation des accès et nouvelle vérification du GPU.
- `emergency_stopped` : arrêt d’urgence ; minage et location interdits.

## Transitions autorisées

- `offline -> idle` uniquement après validation complète des protections.
- `idle -> mining` uniquement si le minage est activé et correctement configuré.
- `mining -> stopping_miner` dès qu’une réservation valide doit démarrer.
- `stopping_miner -> rental_preparing` uniquement après confirmation de libération du GPU.
- `rental_preparing -> rental` uniquement après création réussie de l’environnement isolé.
- `rental -> recovering` à la fin normale, à l’expiration ou lors d’un arrêt contrôlé.
- `recovering -> idle` après destruction et vérification réussies.
- `idle -> mining` après récupération, uniquement si l’autorisation de minage est toujours active.
- Toute anomalie critique mène vers `emergency_stopped` ou `offline`.

## Politique fail-closed

Une location reste bloquée si l’une des conditions suivantes n’est pas prouvée :

- le mineur est réellement arrêté ;
- aucun processus inconnu ne monopolise le GPU ;
- l’environnement isolé est disponible ;
- les secrets temporaires sont prêts ;
- les règles réseau sont appliquées ;
- aucun dossier personnel n’est monté ;
- l’état de sécurité local est valide.

L’absence de preuve est traitée comme un échec, jamais comme une réussite implicite.

## Arrêt propre du mineur

L’intégration système devra :

1. identifier précisément le processus autorisé ;
2. envoyer une demande d’arrêt normal ;
3. attendre pendant un délai borné ;
4. vérifier la fin du processus ;
5. vérifier la libération effective du GPU ;
6. refuser la location si une étape échoue.

Un arrêt forcé ne doit être utilisé que selon une politique explicite et auditable. Il ne doit jamais conduire automatiquement au démarrage d’une location sans nouvelle vérification du GPU.

## Fin de location

Avant toute reprise du minage :

- révoquer les accès et jetons temporaires ;
- arrêter les processus du locataire ;
- détruire l’espace de travail temporaire ;
- supprimer les données éphémères ;
- vérifier les processus GPU restants ;
- contrôler l’état du pilote et du GPU ;
- enregistrer un événement d’audit sans données personnelles du locataire.

## Interface utilisateur

L’interface doit expliquer simplement :

- « GPU libre » ;
- « Minage optionnel actif » ;
- « Réservation reçue — arrêt propre du mineur » ;
- « Préparation de l’environnement sécurisé » ;
- « Location en cours » ;
- « Nettoyage sécurisé » ;
- « GPU de nouveau disponible ».

Elle ne doit jamais annoncer une location active avant confirmation du service système.

## Limites de l’implémentation actuelle

La version actuelle contient la représentation TypeScript et l’affichage de cette politique dans l’interface. Elle ne pilote pas encore un véritable processus de minage.

Le pilotage réel devra être implémenté dans un service système séparé, privilégié uniquement pour les opérations nécessaires, avec :

- liste blanche stricte des exécutables autorisés ;
- configuration validée ;
- journal d’audit ;
- délais d’arrêt bornés ;
- vérification native du GPU ;
- tests Windows, macOS et Linux ;
- installateurs et binaires signés.

## Critères de production

Cette fonctionnalité ne sera considérée prête que lorsque :

- les transitions sont testées automatiquement ;
- les pannes et interruptions sont couvertes ;
- aucun chevauchement minage/location n’est possible ;
- le nettoyage est vérifié après chaque location ;
- l’arrêt d’urgence fonctionne dans tous les états ;
- les tests multi-OS passent ;
- une revue de sécurité indépendante est terminée.
