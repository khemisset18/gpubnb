# GPUbnb — isolation Windows pragmatique sans Linux

**Statut : conception candidate, pas de mise en production.** Cette note accompagne la PR #380. Elle n'autorise pas les locations, l'activation d'un PC, le streaming réel, le merge ni un déploiement Render.

## Objectif

Permettre à un loueur de proposer son GPU sur Windows natif avec le minimum d'isolation **utile et vérifiable**, sans imposer une VM pour chaque scénario ni prétendre qu'un simple compte Windows rend sûr un locataire inconnu.

Les transports WebSocket H.264, le navigateur, l'Agent, l'écran virtuel et les jetons GPUbnb sont **distincts** de la frontière Windows entre propriétaire et locataire. Une image fluide ne prouve pas que le système est privé.

## Deux niveaux de déploiement

| Mode | Usage envisagé | Ce qui doit réellement exister | Limite |
| --- | --- | --- | --- |
| **Machine Windows physiquement dédiée à la location**, une session à la fois | Premiers Workspaces Creator / CAD | Ordinateur dédié sans données personnelles, session locataire préprovisionnée et non administrateur, présence exclusive de cette session, GPU exact, helper signé, écran locataire prouvé, réseau LAN propriétaire isolé, STOP et effacement vérifiés | Pas de VM : un programme malveillant peut encore chercher à exploiter l'hôte ; aucune annonce « isolation forte » |
| **VM Windows avec GPU supporté ou hôte physiquement réinitialisé entre tiers** | Bureau général, Developer, IA, Gaming, programmes/jeux non fiables et multiples locataires | Isolation OS/VM ou remise à zéro intégrale, licences Windows/jeux/GPU, accès GPU attesté, contrôles réseau et STOP | Dépend du GPU, de l'OS, des pilotes, des licences et du matériel ; pas universellement gratuit |

L'usage normal d'un **PC personnel du propriétaire**, avec ses fichiers, ses comptes ouverts ou ses accès réseau, **n'entre pas dans le premier niveau**. Un compte locataire local seul ne protège pas de toutes les erreurs d'ACL, des vulnérabilités locales ni d'un logiciel hostile.

## Minimum à ne pas contourner

1. **Identités Windows distinctes** : SID propriétaire différent du SID locataire et des comptes SYSTEM ; le service ne choisit jamais la console propriétaire comme solution de secours.
2. **Compte locataire non administrateur** : dans `native/windows-platform/src/session.rs`, vérification du jeton WTS Windows avant lancement ; rejet de `TokenElevation` non nul et de toute présence du groupe local `BUILTIN\\Administrators`, même en mode UAC filtré (« deny-only »). Une erreur de requête de jeton est un refus, pas une autorisation.
3. **Un utilisateur interactif à la fois** : session locataire WTS/console explicitement attribuée, exclusivement active, déverrouillée ; les processus du SID propriétaire sont absents de cette session. Le helper existant vérifie ces points, sans créer automatiquement une session WTS Windows inexistante.
4. **Source graphique dédiée, jamais écran personnel** : IddCx/IDDD ou preuve de source locataire autorisée, capture NVENC et identité du GPU physique exact. Toute ambiguïté annule le streaming.
5. **Entrée bornée** : le navigateur n'envoie clavier/souris que lorsque le canvas a le focus ; perdre le focus, masquer l'onglet, fermer le canal ou changer de génération libère les touches et boutons maintenus. Le Gateway revérifie aussi les autorisations à la réception/envoi.
6. **Arrêt fiable** : STOP, expiration, perte de preuve, changement de locataire, erreur helper et réaffectation GPU doivent révoquer les entrées et médias, stopper le worker, nettoyer la session et libérer les ressources **seulement après confirmation du nettoyage**. La simple fermeture du lecteur vidéo n'est **pas** un STOP de la location.
7. **Réseau** : bloquer l'accès du locataire au LAN du propriétaire, y compris services et partages Windows, et contrôler le réseau sortant pour les jeux. Le champ `networkAccess: RESTRICTED` en base **ne constitue pas à lui seul un pare-feu Windows effectif**. Tant que cette preuve n'existe pas, ne pas vendre un bureau général à un inconnu.
8. **Accès commercial** : réservation payée du Workspace exact, propriétaire opt-in, allocation unique du GPU, authentification et jetons temporaires, revocation/STOP et approbation de sécurité **formelle et indépendante sur le HEAD exact** avant toute permission de mise en service.

## Fonctionnalité actuelle et travaux restants

| Profil | Parcours code | Streaming audiovisuel/contrôle | Niveau de preuve |
| --- | --- | --- | --- |
| Creator (Blender) | Réservation native, démarrage helper, navigateur candidat | H.264, clavier, souris en code ; application Windows exigée | Sans preuve sur machine réelle, **pas prêt public** |
| CAD (FreeCAD) | Idem | H.264, clavier, souris | Sans preuve sur machine réelle, **pas prêt public** |
| Cloud Desktop | Candidat technique | H.264/clavier/souris ; audio navigateur absent | **Bloqué commercialement**, aucune promesse de bureau complet |
| Gaming | Candidat technique | Audio et manette navigateur non implémentés | **Bloqué commercialement**, aucune promesse Steam fonctionnel |

Les applications de création peuvent exécuter du code/script arbitraire ; un programme hostile peut également être chargé dans un projet Blender ou FreeCAD. **Un PC loué doit donc être dédié, sans secrets personnels, même pour Creator/CAD**. Pour les autres usages, privilégier la VM ou un hôte physiquement dédié remis à zéro avant un nouveau locataire.

## Ce que la PR #380 apporte, sans activer le service

- Analyse de compatibilité native Windows séparée de Docker/Linux et liaison au GPU physique vendu.
- Réservation et session rattachées au slug exact ; refus des substitutions Compute/Developer.
- Gateway révoquant les accès sur STOP ; helper natif avec contrat de preuve physique.
- Protection du navigateur contre l'injection involontaire de touches/souris hors du canvas.
- Refus au niveau Win32 des comptes locataires administrateurs, même avec jeton UAC filtré.
- Documentation explicite sur la différence entre « fermer la vidéo » et « arrêter la location ».

Les verrous `WINDOWS_NATIVE_RENTALS_ENABLED=false`, les restrictions de compte/console, l'absence de stream PC1→PC2 et l'exigence de revue indépendante **restent inchangés**. Aucune CI verte, capture vidéo simulée ou expérience personnelle d'un locataire ne remplace une preuve de l'isolation et de la révocation.

## Références du code

- `native/windows-platform/src/session.rs` — token WTS, SID, exclusivité et non-admin.
- `native/windows-stream-helper/src/renter_lease.rs` — bail de session préprovisionné.
- `native/windows-stream-helper/src/lifecycle.rs` — READY/DEGRADED/STOPPING, validité des preuves.
- `apps/api/src/windows-native-rental-eligibility.ts` — conditions de location, blocages audio/manette.
- `apps/web/windows-native-desktop.js` — vidéo H.264 et contrôle d'entrée borné au focus.
- `apps/api/src/workspace-session-stop.ts`, `workspace-gateway.ts` — revocation du bail et fin de session.
