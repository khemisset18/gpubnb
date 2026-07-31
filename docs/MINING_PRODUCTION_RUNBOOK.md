# Runbook de production — minage optionnel GPUbnb

## Objectif

Ce document décrit la procédure de validation, de déploiement, de surveillance et de retour arrière du volet minage optionnel.

La location reste prioritaire. Le minage doit rester désactivé par défaut après déploiement.

## Préconditions de fusion dans `main`

Avant de fusionner la PR :

- vérifier que la PR pointe vers `main` et reste fusionnable sans conflit ;
- vérifier que les six workflows sont verts sur le SHA exact de tête ;
- vérifier qu'aucun secret brut, token ou clé privée n'est présent dans le diff ;
- vérifier que Prisma et toutes les migrations s'appliquent sur une base PostgreSQL vide ;
- vérifier que la documentation correspond aux routes et états réellement implémentés ;
- confirmer que `autoResumeAfterRental` est `false` par défaut dans le runtime, Prisma et PostgreSQL ;
- confirmer que la fonctionnalité reste inactive tant que le propriétaire ne l'autorise pas explicitement.

Workflows obligatoires :

- `CI`
- `api-mining-ci`
- `deployment-readiness`
- `host-desktop`
- `host-desktop-dev-installers`
- `host-windows-preflight`

Ne jamais fusionner si un contrôle est en attente, annulé ou en échec.

## Migrations incluses

Les migrations du volet minage créent ou renforcent :

- les ressources CPU/GPU ;
- les configurations de minage ;
- les événements runtime ;
- les journaux d'audit ;
- le compteur monotone obligatoire ;
- le trigger PostgreSQL de redaction des références de secrets.

Commande de validation avant déploiement :

```bash
cd apps/api
npm ci
npx prisma validate
npx prisma generate
npx prisma migrate status
```

Commande de déploiement :

```bash
npx prisma migrate deploy
```

Ne pas utiliser `prisma db push` en production.

## Ordre de déploiement

1. sauvegarder la base PostgreSQL ;
2. vérifier la disponibilité de Redis ;
3. déployer les migrations Prisma ;
4. déployer l'API ;
5. vérifier les probes de santé et les erreurs de démarrage ;
6. déployer le desktop/agent signé ;
7. conserver le minage désactivé ;
8. activer uniquement sur des machines de test internes ;
9. contrôler les événements runtime et les journaux d'audit ;
10. élargir progressivement après validation matérielle.

## Vérifications fonctionnelles après déploiement

### Configuration propriétaire

- la liste des ressources contient séparément CPU et GPU ;
- une ressource louée refuse une modification de configuration ;
- une ressource en quarantaine refuse l'activation du minage ;
- une version obsolète retourne un conflit ;
- le pool géré applique 100 points de base ;
- le pool propriétaire applique 0 point de base ;
- un mot de passe brut est rejeté dans `ownerPoolSecretRef` ;
- une référence de coffre autorisée est acceptée ;
- la référence de coffre n'apparaît pas dans les réponses de liste.

### Sécurité des événements runtime

Tester :

- signature Ed25519 V2 valide ;
- signature invalide ;
- timestamp expiré ;
- nonce rejoué ;
- hash du corps incorrect ;
- absence du corps brut ;
- machine inconnue ou révoquée ;
- ressource appartenant à une autre machine ;
- compteur inférieur ou identique ;
- doublon idempotent strictement identique ;
- collision de clé d'idempotence avec un autre contenu.

### Priorité location

Scénario minimal :

1. démarrer volontairement le minage d'une ressource ;
2. préparer une location de cette ressource ;
3. confirmer l'arrêt du mineur et de ses enfants ;
4. confirmer la libération des handles et conteneurs ;
5. confirmer que la location ne commence pas avant la preuve d'arrêt ;
6. terminer la location et exécuter le nettoyage ;
7. confirmer l'absence de reprise si `autoResumeAfterRental` est désactivé ;
8. confirmer la reprise uniquement lorsqu'il est activé et que la ressource minait avant la location.

## Surveillance

Alertes recommandées :

- hausse des `invalid_agent_request` ;
- répétition de `agent_counter_replay` ;
- collisions d'idempotence ;
- ressources en `QUARANTINED` ou `EMERGENCY_STOPPED` ;
- temps de préemption supérieur au SLA ;
- échecs de nettoyage ;
- température ou puissance hors limites ;
- crash répété du mineur ;
- divergence entre l'état desktop et l'état PostgreSQL ;
- erreurs du trigger d'audit ou migrations incomplètes.

Les journaux ne doivent jamais contenir de clés privées, mots de passe de pool, tokens, secrets résolus ni commandes sensibles.

## Procédure d'incident

En cas de comportement dangereux :

1. désactiver le minage au niveau de la configuration ;
2. arrêter les processus de minage concernés ;
3. placer les ressources en quarantaine ;
4. préserver les logs, événements et compteurs ;
5. vérifier qu'aucune location active n'est impactée ;
6. révoquer la clé agent si une compromission est suspectée ;
7. bloquer le profil de mineur concerné ;
8. ouvrir un incident avec chronologie et machines touchées.

## Retour arrière

Le retour arrière applicatif consiste à redéployer la version API et desktop précédente, tout en conservant les migrations déjà appliquées lorsque celles-ci sont compatibles et additives.

Ne pas supprimer manuellement les tables, événements ou compteurs en production.

Si une migration provoque une défaillance :

- arrêter le déploiement ;
- restaurer la sauvegarde dans un environnement isolé ;
- diagnostiquer la migration ;
- produire une migration corrective en avant ;
- ne jamais modifier l'historique d'une migration déjà appliquée en production.

Le trigger de redaction d'audit peut rester actif même si le volet minage est temporairement désactivé.

## Critères d'activation publique

La fusion du code dans `main` ne signifie pas que le minage public est autorisé.

L'activation publique nécessite encore :

- tests physiques NVIDIA et AMD ;
- validation antivirus et licences ;
- audit SSRF/DNS rebinding ;
- coffre de secrets réellement exploité et rotation testée ;
- monitoring, alertes et astreinte ;
- validation des paiements et de la réconciliation 99 % / 1 % ;
- revue juridique, fiscale et sanctions.

Tant que ces éléments ne sont pas terminés, garder les profils concernés désactivés et limiter les essais à un environnement contrôlé.
