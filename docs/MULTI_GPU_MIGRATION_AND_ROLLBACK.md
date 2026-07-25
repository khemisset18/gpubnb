# Migration et rollback du marketplace multi-GPU

## Principe

La migration est additive. Les colonnes GPU historiques de `Machine` restent présentes pendant toute la période de transition. Les API existantes peuvent donc continuer à lire `gpuUuid`, `gpuModel`, `vramMiB`, `driverVersion` et `gpuVendor` tandis que les nouvelles API utilisent `Accelerator`.

## Déploiement progressif

1. Déployer les nouvelles tables et contraintes.
2. Créer automatiquement un `Accelerator` pour chaque ancienne machine possédant déjà des informations GPU.
3. Continuer à écrire les anciennes colonnes pendant une période de double écriture.
4. Faire remonter l’inventaire complet de tous les GPU par l’agent Host.
5. Comparer les anciennes informations avec le premier accélérateur détecté.
6. Activer les offres `SELECTED_ACCELERATORS` et `COMPUTE_POOL` uniquement pour les machines dont l’isolation est vérifiée.
7. Migrer les lectures publiques et le tableau de bord vers les nouveaux modèles.
8. Supprimer les anciennes colonnes dans une PR et une migration ultérieures, jamais dans cette fondation.

## Compatibilité des anciennes offres

Toutes les offres existantes reçoivent automatiquement le mode `FULL_MACHINE`. Leur comportement actuel est donc conservé. Une ancienne réservation continue de cibler son `GpuListing` et sa machine comme auparavant.

Les nouvelles allocations ne sont créées que par le nouveau service d’allocation. Aucun backfill automatique des anciennes réservations n’est effectué afin de ne pas inventer des ressources historiques qui n’étaient pas enregistrées.

## Règles de sécurité

- Un GPU ne peut appartenir qu’à une seule machine.
- Une offre ne peut sélectionner que les GPU de sa propre machine.
- Deux allocations actives du même GPU ne peuvent pas se chevaucher.
- Deux locations complètes de la même machine ne peuvent pas se chevaucher.
- Une location complète entre en conflit avec toute location partielle de GPU de la même machine.
- Deux GPU différents d’une même machine peuvent être loués en même temps uniquement lorsque l’isolation de la machine et des accélérateurs a été vérifiée.
- Une libération anticipée conserve l’allocation pour l’audit.

## Stratégie de rollback

Tant que les nouvelles API ne sont pas activées en production, le rollback applicatif consiste à redéployer la version précédente : les anciennes colonnes et relations sont toujours intactes.

Après activation des nouvelles offres, un rollback destructif est interdit tant qu’il existe des lignes dans `ListingAccelerator`, `MachineAllocation` ou `AcceleratorAllocation`. Il faut alors :

1. désactiver la création de nouvelles offres multi-GPU ;
2. laisser terminer ou annuler les réservations concernées ;
3. exporter les nouvelles tables pour l’audit ;
4. remettre les offres compatibles en mode `FULL_MACHINE` ;
5. seulement ensuite supprimer les nouvelles contraintes et tables dans une migration dédiée.

## Validation avant sortie du mode brouillon

- `prisma migrate deploy` sur base vide ;
- `prisma migrate deploy` sur une copie contenant des machines et offres historiques ;
- vérification du backfill d’un accélérateur par ancienne machine ;
- tests SQL de chevauchement ;
- tests applicatifs d’autorisation Host ;
- tests avec deux transactions PostgreSQL concurrentes ;
- validation que l’onboarding, le diagnostic et l’agent existants restent fonctionnels ;
- validation explicite du plan de retour arrière.
