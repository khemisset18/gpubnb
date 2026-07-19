# Déploiement de test sans base Render payante

Architecture :

- Supabase : PostgreSQL
- Upstash : Redis
- Render : API uniquement
- Netlify : interface web
- Solana Devnet : paiements de test

## 1. Supabase

Dans **Connect > Direct**, récupérer deux URI :

- `DATABASE_URL` : Transaction pooler, port 6543, avec `?pgbouncer=true&connection_limit=1`
- `DIRECT_URL` : Direct connection, port 5432

Ne jamais publier le mot de passe. Si le mot de passe contient des caractères spéciaux, les encoder dans l'URI.

## 2. Upstash

Créer une base Redis gratuite et copier l'URI TLS complète commençant par `rediss://` dans `REDIS_URL`.

## 3. Render

Créer un Blueprint à partir du dépôt. Le nouveau `render.yaml` ne crée plus ni PostgreSQL ni Redis sur Render.

Entrer uniquement ces valeurs secrètes dans Render :

- `DATABASE_URL`
- `DIRECT_URL`
- `REDIS_URL`
- `PUBLIC_APP_ORIGIN` (mettre provisoirement l'URL Netlify plus tard)

Les autres secrets sont générés par Render.

## 4. Netlify

Déployer le dossier `apps/web`. Après obtention de l'URL de l'API Render, modifier `apps/web/config.js` :

```js
window.GPUBNB_API_URL='https://VOTRE-API.onrender.com';
```

Puis pousser la modification sur GitHub afin que Netlify redéploie.

## Sécurité

- Garder `ALLOW_MAINNET=false`.
- Ne jamais partager une seed phrase, une clé privée ou une clé Supabase secrète.
- Cette configuration est destinée aux essais Devnet, pas aux fonds réels.
