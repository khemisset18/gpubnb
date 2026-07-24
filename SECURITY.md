# Modèle de sécurité

## Garanties implémentées
- Nonces d'authentification consommés une seule fois dans Redis.
- Cookies de session opaques HttpOnly/SameSite.
- CORS limité à l'origine publique.
- Heartbeats avec challenge à usage unique, compteur monotone et fenêtre temporelle.
- États de connectivité, exploitation et modération séparés.
- DTO public sans clé d'agent ni portefeuille complet.
- Tous les montants restent en `bigint` et sont sérialisés en chaînes.
- Endpoint de maintenance protégé par secret de service.
- Règlement testé avec invariant de conservation des lamports.

## GPUbnb Host Desktop

L'application hôte reste pré-production et doit échouer de manière fermée tant que la barrière de préparation n'est pas satisfaite.

Invariants bloquant toute publication :

- aucune charge locataire ne peut accéder au bureau, au dossier personnel, au profil navigateur, au presse-papiers, aux identifiants, aux périphériques ou aux sockets non autorisés de l'hôte ;
- les opérations privilégiées s'exécutent uniquement dans un service minimal et signé ;
- les requêtes du service sont authentifiées, limitées à une liste blanche, protégées contre le rejeu et soumises à une fenêtre temporelle stricte ;
- les identifiants et espaces de travail locataire sont éphémères et détruits après chaque session ;
- l'arrêt d'urgence reste disponible pendant la préparation, la location et le nettoyage ;
- aucune location ne démarre tant que le mineur détient le GPU ou que l'isolation, le stockage et le réseau ne sont pas attestés ;
- toute preuve manquante, ancienne, ambiguë ou invalide bloque l'hébergement.

## Signalement responsable

Ne publiez pas de vulnérabilité exploitable dans une issue publique. Utilisez le signalement privé de vulnérabilité GitHub lorsqu'il est activé et fournissez le commit affecté, les étapes de reproduction, l'impact et une mitigation proposée. N'incluez jamais de vrais secrets, clés privées, données locataire ou fichiers personnels.

## Limites obligatoires avant Mainnet et production
- Audit indépendant du programme Anchor compilé et de son ID réel.
- Multisig pour admin, oracle et upgrade authority.
- Oracle redondant : l'agent fournisseur seul n'est jamais une preuve suffisante.
- Sandbox GPU testée contre l'évasion, idéalement microVM/Kata selon le matériel.
- Tests dynamiques avec validateur Solana local, chaos réseau et pannes électriques.
- Pentest de l'infrastructure réellement déployée.
- CI multi-OS, analyse statique, revue des dépendances, artefacts signés et revue indépendante de la frontière d'isolation du Host Desktop.
