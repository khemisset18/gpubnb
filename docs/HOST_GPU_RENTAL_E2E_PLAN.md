# Host Desktop, location GPU et orchestration

## Objectif

Livrer un Host Desktop professionnel capable de gérer une location GPU de bout en bout, avec une orchestration fail-closed entre disponibilité, minage optionnel, location, nettoyage et reprise.

## Priorité absolue

Une location GPU financée et vérifiée est toujours prioritaire sur le minage.

Le flux obligatoire est :

1. machine certifiée et disponible ;
2. minage optionnel uniquement lorsque la machine est libre ;
3. réception d'une réservation authentifiée et financée ;
4. arrêt du mineur ;
5. preuve que tous les processus de minage sont terminés ;
6. préparation d'un workspace isolé ;
7. preuve d'isolation, d'exclusivité GPU et d'accès temporaire ;
8. session locataire active ;
9. fin de session ;
10. révocation des accès et destruction du workspace ;
11. vérification GPU, stockage et réseau ;
12. reprise du minage uniquement si toutes les vérifications réussissent.

## États du coordinateur

- `offline`
- `available`
- `mining`
- `stopping_mining`
- `preparing_rental`
- `rental_active`
- `cleaning_rental`
- `quarantined`
- `emergency_stopped`

Une transition non prévue est refusée. Une preuve de sécurité manquante place la machine en quarantaine.

## Frontières de sécurité

- aucune location sans réservation financée ;
- identifiants strictement validés ;
- aucune commande shell arbitraire ;
- aucune exécution provenant directement d'une entrée utilisateur ;
- aucun démarrage de location avant arrêt confirmé du mineur ;
- aucune ressource non réservée exposée ;
- aucun retour à l'état disponible avant nettoyage complet ;
- aucune sortie de quarantaine sans revue locale et recertification ;
- arrêt d'urgence disponible pendant tout le cycle.

## Configuration du minage par le propriétaire

Le minage est facultatif et appartient exclusivement au propriétaire de la machine. Le locataire, le control plane et le service hôte ne peuvent pas modifier ses préférences.

Le propriétaire peut :

- désactiver complètement le minage ;
- activer le minage automatique seulement lorsque le GPU est libre ;
- choisir une crypto parmi les profils approuvés ;
- utiliser une pool gérée par GPUbnb ;
- ou fournir sa propre pool compatible avec un protocole Stratum autorisé ;
- définir son wallet, son nom de worker et une référence vers un secret stocké séparément.

La configuration ne contient jamais :

- un chemin d'exécutable arbitraire ;
- une commande shell ;
- des arguments libres ;
- un mot de passe brut ;
- des identifiants intégrés dans l'URL de pool ;
- une URL HTTP servant à télécharger ou exécuter un programme.

Le profil de mineur est choisi dans une liste approuvée et signée. La résolution d'une pool gérée provient d'un catalogue de confiance. Une réservation financée arrête toujours le minage, quelle que soit la configuration du propriétaire.

## Architecture cible

### Interface Tauri

L'interface utilisateur reste non privilégiée. Elle affiche l'état et demande des actions au service local signé.

### Service GPUbnb Host

Le service privilégié détient la machine d'états, valide les commandes authentifiées, applique l'anti-rejeu et coordonne les adaptateurs natifs.

### Adaptateur de workspace

Responsable de la création, de l'isolation, de l'attachement exclusif du GPU, de la supervision et de la destruction du workspace.

### Adaptateur de minage

Responsable uniquement d'un binaire approuvé, signé et configuré par des paramètres structurés. Il doit fournir une preuve fiable d'arrêt avant toute location. Il reçoit un `MiningLaunchSpec` validé et ne construit jamais une ligne de commande à partir d'un texte libre.

### API GPUbnb

Responsable de l'identité, des machines, des annonces, de la réservation, de la preuve de financement et de la réception des mesures d'usage.

## Critères de validation de bout en bout

- association utilisateur-machine authentifiée ;
- annonce GPU publiée depuis une machine certifiée ;
- réservation créée et financée sur Devnet ;
- réservation transmise au bon Host Desktop ;
- configuration de minage modifiable uniquement par le propriétaire ;
- profil de mineur et pool validés avant démarrage ;
- arrêt du minage vérifié ;
- workspace isolé créé ;
- GPU réservé attaché exclusivement ;
- accès locataire temporaire fonctionnel ;
- télémétrie et arrêt d'urgence fonctionnels ;
- session terminée ;
- accès révoqués ;
- workspace détruit ;
- GPU sain et remis en disponibilité ;
- reprise du minage seulement après nettoyage validé ;
- scénario testé sur deux machines distinctes.

## État actuel de la branche

Le coordinateur fail-closed, le règlement proportionnel, la validation de configuration du minage et leurs tests automatisés sont présents. Les préférences de minage ne sont pas encore persistées ni reliées à un adaptateur natif réel. Les adaptateurs de workspace, le transport authentifié API vers Host Desktop et l'exécution réelle d'un mineur approuvé restent à connecter avant de déclarer le parcours entièrement fonctionnel sur deux machines.
