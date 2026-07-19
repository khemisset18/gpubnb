# Rapport de vérification — version Render monolithique

## Réussi

- syntaxe JavaScript du frontend ;
- syntaxe Python de l’agent ;
- 3 tests du calcul de règlement ;
- migration initiale complète contenant les tables, index, clés étrangères et la contrainte anti-chevauchement ;
- configuration Render gratuite limitée à un seul service ;
- site et API servis sur le même domaine ;
- TLS obligatoire pour Redis en production ;
- Mainnet désactivé ;
- aucune clé privée ou clé Supabase incluse dans l’archive.

## Vérification différée au build Render

`prisma generate` n’a pas pu télécharger le moteur Prisma dans l’environnement de préparation à cause d’une panne DNS `EAI_AGAIN` vers `binaries.prisma.sh`. Le Dockerfile exécute cette commande pendant le build Render, où elle doit être vérifiée dans les logs.

## Audit npm

`@fastify/static` a été mis à niveau pour corriger ses alertes de traversée de chemin. Trois alertes modérées restent dans la chaîne `@solana/web3.js -> jayson -> uuid`. La correction automatique proposée par npm installerait une version incompatible de Solana et n’a donc pas été appliquée.

## Statut

Prêt pour un déploiement **Devnet de test**. Non autorisé pour un lancement Mainnet ou pour exécuter des charges GPU non fiables avant audit du smart contract et validation de la sandbox.
