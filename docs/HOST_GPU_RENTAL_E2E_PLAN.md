# Host Desktop et location GPU de bout en bout

## Objectif

Valider une location GPU réelle, sécurisée et reproductible de bout en bout.

## Ordre de réalisation

1. Finaliser le Host Desktop et ses diagnostics natifs.
2. Relier correctement le compte utilisateur, la machine hôte et l'annonce GPU.
3. Créer une réservation réelle sur Devnet et vérifier son financement.
4. Transmettre la réservation au Host Desktop de manière authentifiée.
5. Préparer un environnement locataire isolé.
6. Attacher uniquement le GPU réservé et les ressources explicitement autorisées.
7. Démarrer la session locataire et superviser son état.
8. Mesurer l'usage et transmettre les preuves nécessaires à l'API.
9. Terminer la session, révoquer les accès et détruire l'environnement.
10. Vérifier que le GPU, le stockage et le réseau sont revenus dans un état sain.
11. Exécuter un test complet avec deux machines distinctes.
12. Corriger les problèmes détectés et documenter le résultat.

## Critères de validation

- aucun accès aux fichiers personnels de l'hôte ;
- aucun démarrage de session sans réservation financée et vérifiée ;
- aucune ressource non réservée exposée au locataire ;
- arrêt d'urgence fonctionnel pendant toute la location ;
- clés et accès temporaires révoqués à la fin ;
- nettoyage vérifié avant de rendre la machine disponible ;
- journaux exploitables sans secret ni donnée personnelle sensible ;
- tests automatisés et test manuel sur deux machines réussis.

## Frontières d'architecture à préserver

La branche doit seulement conserver des interfaces génériques entre :

- disponibilité de la machine ;
- préparation d'une location ;
- session active ;
- nettoyage ;
- retour à l'état disponible.

Ces interfaces ne doivent contenir aucune logique métier supplémentaire. Elles servent uniquement à éviter de coupler le Host Desktop à une seule évolution future.

## Hors périmètre

Aucune fonctionnalité secondaire utilisant les ressources libres ne doit être développée dans cette branche. Aucun exécutable, pool, configuration, écran, état métier ou test associé ne doit être ajouté avant la validation complète de la location GPU.