# Activer Google et e-mail via Supabase

1. Dans Supabase, activer Email et Google et imposer la confirmation d’e-mail.
2. Dans Google Cloud, déclarer l’origine `https://<DOMAINE_RENDER>` et le callback Supabase `https://<PROJECT_REF>.supabase.co/auth/v1/callback`.
3. Dans Supabase URL Configuration, définir le Site URL `https://<DOMAINE_RENDER>` et autoriser `https://<DOMAINE_RENDER>/auth.html`.
4. Configurer `SUPABASE_URL` et `SUPABASE_ANON_KEY` dans Render.
5. Définir ces deux valeurs **publiques** dans Render ; l’API génère `GET /public-config.js` et l’URL de redirection.
6. Ne jamais placer le Client Secret Google ou une clé Supabase `service_role` dans Render côté frontend, Git ou le bundle navigateur.
7. Tester inscription, confirmation, connexion, récupération, expiration et déconnexion.
