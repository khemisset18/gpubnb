# Vérification de la release v1.0 Devnet

Exécuté dans l’environnement de construction :

- syntaxe Python de l’agent : réussie ;
- syntaxe JavaScript du frontend et du diagnostic : réussie ;
- contrôles statiques du dépôt : réussis ;
- tests Node de sécurité, règlement et dérivation Solana : **11/11 réussis** ;
- vérification de la configuration par `devnet-doctor` : base valide ;
- compilation TypeScript complète : non exécutée jusqu’au bout, car `prisma generate` n’a pas pu télécharger son binaire (`EAI_AGAIN binaries.prisma.sh`) ;
- compilation Anchor et tests local-validator : non exécutés, Rust, Solana CLI et Anchor CLI n’étant pas installés dans l’environnement.

Ces deux derniers contrôles doivent être exécutés sur la machine de développement ou par GitHub Actions avant tout déploiement Devnet.
