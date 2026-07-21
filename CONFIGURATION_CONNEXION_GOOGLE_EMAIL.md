# Activer Google et e-mail

Le frontend affiche maintenant Google, e-mail et Phantom depuis `apps/web/auth.html`.

1. Ouvrir `apps/web/auth-config.js`.
2. Remplacer `YOUR_PROJECT` et `YOUR_PUBLIC_ANON_KEY` par les valeurs publiques du projet Supabase.
3. Remplacer `YOUR_SITE` par le domaine Netlify réel.
4. Dans Supabase > Authentication > Providers, activer Email et Google.
5. Dans Google Cloud, ajouter l’URL de callback Supabase indiquée dans le panneau du provider Google.
6. Dans Supabase > URL Configuration, ajouter `https://VOTRE_SITE.netlify.app/auth.html` aux Redirect URLs.
7. Configurer aussi côté API `SUPABASE_URL` et `SUPABASE_ANON_KEY` avec le même projet.

Attention : sans ces valeurs propres à votre compte Supabase/Google, aucun ZIP ne peut rendre Google opérationnel automatiquement.
