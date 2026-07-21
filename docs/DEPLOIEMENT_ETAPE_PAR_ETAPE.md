# Déploiement étape par étape

## 1. Publier correctement le dépôt

Utilisez GitHub Desktop. Publiez le dossier racine complet `GPUbnb-PROPRE`. Sur GitHub, la première page doit afficher des dossiers, notamment `apps`, `agent`, `docs`, `infra`, `programs` et `scripts`.

## 2. Récupérer DATABASE_URL dans Supabase

Dans Supabase, ouvrez **Connect** puis copiez la chaîne **Session pooler**, port **5432**. Remplacez le marqueur du mot de passe par le vrai mot de passe de la base. La chaîne commence par `postgres://` ou `postgresql://`.

## 3. Récupérer REDIS_URL dans Upstash

Dans Upstash Redis, ouvrez **Connect**, choisissez le client Node/ioredis et copiez la chaîne TCP TLS complète. Elle doit commencer par `rediss://` et contenir le mot de passe.

## 4. Créer le Blueprint Render

Dans Render : New > Blueprint, puis sélectionnez le nouveau dépôt. Render lit `render.yaml` à la racine et demande seulement :

- `DATABASE_URL`
- `REDIS_URL`

Aucune carte bancaire ne doit être ajoutée pour cette procédure. Si Render demande un moyen de paiement ou affiche une offre payante, arrêtez-vous avant de confirmer.

## 5. Vérification

Après le déploiement, ouvrez :

- l’URL du service pour voir le site ;
- `/health` à la fin de l’URL pour obtenir une réponse JSON contenant `"ok": true`.

## Limites actuelles

Le programme Solana d’escrow n’est pas déployé. Le projet reste bloqué sur Devnet et ne doit pas recevoir de vrais fonds.
