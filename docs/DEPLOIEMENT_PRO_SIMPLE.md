# Déploiement professionnel simplifié — Devnet

Cette version sert **le site et l’API depuis le même service Render**. Cela évite les problèmes de CORS, de cookies inter-domaines et de configuration Netlify. Supabase fournit PostgreSQL et Upstash fournit Redis.

## Secrets à préparer

Deux valeurs seulement sont à saisir manuellement dans Render :

1. `DATABASE_URL` — dans Supabase, utiliser **Connect > Session pooler**, port **5432**. Remplacer le mot de passe dans l’URI et ne jamais publier cette chaîne.
2. `REDIS_URL` — dans Upstash, copier l’URI TCP TLS complète qui commence par `rediss://`.

Tous les autres paramètres sont définis ou générés par `render.yaml`.

## Déploiement

1. Remplacer le contenu du dépôt GitHub par cette version.
2. Dans Render, choisir **New > Blueprint** et connecter le dépôt `gpubnb`.
3. Vérifier que le plan est `Free`, la région `Frankfurt`, et que Render demande uniquement `DATABASE_URL` et `REDIS_URL`.
4. Coller les deux secrets, puis appliquer le Blueprint.
5. Attendre `Live`, ouvrir l’URL Render et vérifier `/health` puis `/ready`.

## Ce qui est automatisé

- construction Docker reproductible ;
- génération Prisma ;
- création/mise à jour des tables au démarrage ;
- site et API sur le même domaine ;
- secrets de session générés par Render ;
- Devnet forcé ;
- Mainnet désactivé ;
- contrôle de santé Render.

## Limites avant lancement commercial

Le site peut être mis en ligne et testé en Devnet. Le programme d’escrow doit encore être déployé et audité, et l’orchestrateur Docker GPU doit être validé avant toute utilisation avec de vrais fonds ou des tâches non fiables.
