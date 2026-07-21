# Installation du module d’authentification

1. Copier `apps/web/auth.html`, `auth.css` et `auth.js` dans le dossier `apps/web` du dépôt.
2. Copier `auth-config.example.js` sous le nom `auth-config.js`, puis ajouter l’URL Supabase et la clé **publique anon**. Ne jamais utiliser la clé service_role dans le navigateur.
3. Dans Supabase SQL Editor, exécuter `supabase/migrations/20260721_auth_profiles.sql`.
4. Dans Supabase > Authentication > Providers :
   - activer Email ;
   - activer Google et configurer le client Google ;
   - activer Web3 Wallet > Solana.
5. Dans Authentication > URL Configuration, ajouter l’URL du site et `https://VOTRE-SITE.netlify.app/auth.html`.
6. Dans Netlify, vérifier que `auth-config.js` est publié.
7. Ajouter dans le menu du site un lien vers `/auth.html`.

## Confidentialité

Le public ne lit que `profiles.pseudonym`, l’avatar et la bio. L’e-mail reste dans le schéma privé `auth`, et le wallet Web3 reste une identité d’authentification. Ne recopiez pas l’e-mail, le nom Google ou le wallet complet dans `profiles`.

## Sécurité à activer

- confirmation d’e-mail ;
- CAPTCHA ;
- limites de connexion Web3 et e-mail ;
- politique de mots de passe d’au moins 12 caractères ;
- MFA pour les administrateurs ;
- RLS sur toutes les futures tables.
