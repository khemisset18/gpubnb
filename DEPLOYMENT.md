# Déploiement

1. Déployer PostgreSQL et Redis sur réseau privé.
2. Déployer `apps/api` sur un service permanent, jamais comme simple site statique.
3. Définir une origine CORS exacte et des secrets aléatoires.
4. Exécuter migrations, tests, build et analyse des dépendances dans la CI.
5. Déployer le programme sur Devnet, remplacer son ID partout, puis tester dépôt, litige, finalisation et remboursement.
6. Déployer `apps/web` sur Netlify et adapter `config.js` et la CSP au domaine réel de l'API.
7. Installer l'agent uniquement sur une machine Linux dédiée, sans données personnelles.

Le ZIP complet n'est pas à déposer entier dans Netlify : Netlify doit recevoir le dossier `apps/web`.
