# GPUbnb v1.1 — Authentification et publication serveur

## Modifications

- Google et e-mail Supabase sont échangés contre une session API GPUbnb via `POST /auth/supabase`.
- Phantom utilise le challenge signé natif de l’API GPUbnb.
- `GET /auth/me` permet au frontend de vérifier la session.
- Une publication anonyme est refusée côté serveur.
- `POST /machines` enregistre une machine sous le compte connecté à partir de sa clé publique agent Ed25519.
- `GET /machines/mine` ne retourne que les machines du compte connecté.
- `POST /listings` vérifie que la machine appartient au compte connecté.
- Une annonce est créée en attente si l’agent n’est pas encore en ligne.
- Le premier heartbeat valide active les annonces en attente.
- Le balayage hors ligne masque les annonces actives quand l’agent ne répond plus.
- La page `publish.html` n’utilise plus `localStorage` et redirige vers la connexion si nécessaire.
- Les annonces locales fictives ont été retirées de la marketplace.

## Configuration requise

Configurer `SUPABASE_URL` et `SUPABASE_ANON_KEY` dans Render. L’API sert ensuite les valeurs publiques via `/public-config.js`.

Ajouter côté API :

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

Google doit être activé dans Supabase Auth et l’URL de redirection doit correspondre au site déployé.

## Vérifications effectuées

- Syntaxe JavaScript frontend : OK.
- Syntaxe Python de l’agent : OK.
- Tests API existants : 11/11 réussis.
- La génération Prisma complète n’a pas pu être répétée dans cet environnement, car le téléchargement du binaire Prisma externe était indisponible. Exécuter `npm run build` dans `apps/api` avec accès réseau avant déploiement.
