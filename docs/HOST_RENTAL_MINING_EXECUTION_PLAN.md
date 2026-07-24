# Host Desktop, location GPU et minage opportuniste

## Ordre de livraison

1. Finaliser le Host Desktop et ses protections natives.
2. Faire fonctionner une location GPU de bout en bout.
3. Brancher l'orchestrateur local `libre -> minage -> location -> nettoyage -> reprise`.
4. Activer une première cryptomonnaie via une pool externe validée.
5. Développer ensuite seulement la GPUBNB Pool.

## Règle de priorité

`location > sécurité > disponibilité locale > minage`

Une réservation confirmée ne démarre jamais tant que l'arrêt du mineur n'est pas vérifié. Le minage ne reprend jamais tant que la destruction du workspace locataire et le nettoyage ne sont pas vérifiés.

## États du Host

- `offline` : protections non certifiées ;
- `idle` : machine libre, minage inactif ;
- `mining` : minage opportuniste autorisé localement ;
- `stopping_mining` : réservation reçue, arrêt en cours ;
- `preparing_rental` : mineur arrêté, workspace en préparation ;
- `rental_active` : ressources attribuées au locataire ;
- `cleaning_rental` : révocation, destruction et contrôle après location ;
- `quarantined` : anomalie de sécurité, aucune location ni reprise automatique.

## Première intégration crypto

La première fiche supportée est Monero avec pool externe TLS. Cette étape fournit uniquement :

- une configuration structurée ;
- une validation stricte de l'hôte, du port, du wallet et du worker ;
- le choix CPU, GPU ou CPU+GPU dans le modèle ;
- le refus des IP littérales, de localhost et des domaines locaux ;
- aucune commande shell et aucun argument arbitraire ;
- aucune clé privée ou seed phrase.

L'exécution réelle du mineur restera derrière un adaptateur signé et allowlisté. La présente tranche ne télécharge ni n'exécute de binaire de minage.

## Location GPU bout en bout : critères de sortie

La location réelle sera considérée terminée uniquement lorsque les éléments suivants seront reliés :

1. réservation financée confirmée par l'API ;
2. ordre signé reçu par le Host ;
3. arrêt CPU/GPU du minage et preuve de libération ;
4. création d'un workspace isolé ;
5. accès temporaire du locataire ;
6. télémétrie et preuve d'usage ;
7. fin de session et révocation des accès ;
8. destruction du workspace ;
9. contrôle GPU/CPU, réseau et stockage ;
10. reprise éventuelle du minage selon la préférence locale.

## GPUBNB Pool

La GPUBNB Pool n'est pas incluse dans cette branche. Elle sera un service séparé après validation de la location réelle et de l'orchestration locale. Les frais annoncés devront être transparents, audités et calculés sur les récompenses effectivement comptabilisées.
