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
- le pool GPUbnb géré reste refusé tant que son runtime n'est pas qualifié ;
- le pool propriétaire opérationnel applique 0 point de base ;
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

## Chemin durable START/STOP GPU v1

Le runtime GPU v1 est NVIDIA uniquement.

Le démarrage owner-pool suit obligatoirement ce chemin :

1. le navigateur envoie uniquement `POST .../start`, sans pool, wallet, UUID, fence ni paramètres runtime ;
2. l'API recharge la configuration propriétaire et l'Accelerator exact ;
3. l'API refuse ressource désactivée, louée, quarantined, GPU non-NVIDIA ou profil non approuvé ;
4. l'API acquiert un ResourceLease Redis de 300 secondes ;
5. le fencing token du lease devient exactement `runtimeGeneration` ;
6. l'API crée une MachineCommand durable d'une durée maximale de 240 secondes ;
7. le claim SQL refuse toute commande mining non clôturée ;
8. le dispatcher TypeScript vérifie de nouveau `resourceId` et le fence ;
9. le Gateway Rust vérifie que le lease est encore exactement actif dans Redis ;
10. l'Agent exige le lease au décodage puis applique de nouveau le fence localement ;
11. un ACK terminal réussi START fait passer uniquement `STARTING -> MINING` ;
12. un ACK terminal réussi STOP fait passer uniquement `VERIFYING_STOP -> STOPPED` ;
13. un ACK tardif ne peut pas écraser un état serveur plus récent ;
14. un échec d'exécution non vérifié place la ressource en quarantaine fail-closed.

Le STOP propriétaire réutilise uniquement un lease mining appartenant à la même ressource.
Un lease rental/étranger reste bloquant. Si aucun lease n'existe, STOP peut acquérir un nouveau
fence plus récent ; l'Agent autorise ce fence plus récent uniquement pour arrêter un ancien mineur
survivant.

Le rollout des commandes mining est séparé du rollout MachineCommand utilisé par la location.
`MINING_COMMAND_GATEWAY_ROLLOUT_BPS` reste à `0` par défaut tant que la validation physique E2E
ci-dessous n'est pas terminée. Il ne peut jamais dépasser `MACHINE_COMMAND_GATEWAY_ROLLOUT_BPS`,
qui reste lui-même borné par le rollout du canal Agent. Ainsi, activer le fast path rental ne rend
jamais START_MINING / STOP_MINING publics par effet de bord.

## Validation physique E2E avant rollout

Sur une machine NVIDIA de test :

1. vérifier la configuration OWNER_POOL sans secret de pool ;
2. démarrer depuis le portail owner ;
3. confirmer `STARTING -> MINING` après ACK terminal ;
4. confirmer que l'UUID NVIDIA exécuté correspond exactement au MiningResource ;
5. confirmer réception de jobs et au moins une share acceptée ;
6. vérifier télémétrie température, watts, utilisation, hashrate, shares et uptime ;
7. vérifier les avertissements thermiques 85 / 90 / 94 / 97 °C ;
8. vérifier l'arrêt exact au seuil propriétaire choisi ;
9. relancer puis arrêter depuis le portail ;
10. confirmer `VERIFYING_STOP -> STOPPED` et absence du processus ;
11. simuler perte capteur et confirmer arrêt fail-closed après trois échecs consécutifs ;
12. lancer une location prioritaire et confirmer qu'aucune location ne démarre avant arrêt vérifié ;
13. vérifier qu'un ACK/fence ancien est rejeté ;
14. redémarrer l'Agent pendant/après minage et confirmer la réconciliation PID + creation token + chemin + SHA-256 ;
15. vérifier qu'aucun wallet, pool secret, token, argument sensible ou chemin privé n'apparaît dans les logs/API.

## Critères d'activation publique

La fusion du code dans `main` ne signifie pas que le minage public est autorisé.

Pour le runtime GPU v1 NVIDIA OWNER_POOL, l'activation publique nécessite encore :

- validation physique E2E du chemin durable ci-dessus ;
- validation antivirus et licences des binaires épinglés ;
- maintien des protections SSRF et DNS rebinding ;
- TLS Stratum Agent qualifié ; le probe TLS Host Desktop doit rester fail-closed tant qu'il ne possède pas une validation certificat/hostname équivalente ;
- aucune utilisation de `ownerPoolSecretRef` tant que le chemin de livraison du secret au mineur n'est pas prouvé sans fuite argv/log ;
- monitoring, alertes et procédure d'incident ;
- revue juridique, fiscale et sanctions applicable au service.

AMD reste hors périmètre GPU v1 jusqu'à implémentation et qualification d'un adapter resource-scoped dédié.
Le pool GPUbnb géré et sa commission future restent hors périmètre tant que leur runtime et leur
comptabilité ne sont pas implémentés et qualifiés.

Tant que ces éléments ne sont pas terminés, garder le rollout public à 0 et limiter les essais à un environnement contrôlé.
