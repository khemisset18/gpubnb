# Étape 1 — GitHub puis aperçu Netlify

Cette procédure est destinée à une personne qui ne code pas.

## A. Préparer le dossier

1. Extraire l’archive dans un dossier normal, par exemple `Documents/GPUbnb-v1.0-DEVNET`.
2. Ne jamais envoyer le ZIP lui-même dans GitHub.
3. Dans le dossier extrait, vérifier la présence de `apps`, `agent`, `programs`, `docs`, `render.yaml` et `README.md`.

## B. Publier avec GitHub Desktop

1. Installer GitHub Desktop et se connecter.
2. Choisir **File → Add local repository**.
3. Sélectionner le dossier extrait.
4. Si GitHub Desktop propose **create a repository here**, l’accepter.
5. Écrire `Initial GPUbnb v1.0 Devnet` dans Summary.
6. Cliquer **Commit to main**, puis **Publish repository**.
7. Garder le dépôt **Private**.

Le dépôt GitHub doit afficher les dossiers complets. Ne pas utiliser le bouton web **Upload files** pour tout le projet.

## C. Créer l’aperçu du site sur Netlify

1. Dans Netlify, choisir **Add new project → Import an existing project**.
2. Autoriser GitHub puis sélectionner le dépôt GPUbnb.
3. Base directory : `apps/web`.
4. Build command : laisser vide.
5. Publish directory : `.`.
6. Déployer.

À ce stade, Netlify affiche l’interface. Les fonctions de réservation resteront inactives tant que l’API Render et les variables ne sont pas configurées.

## D. Règle de sécurité

Ne jamais mettre dans GitHub : seed phrase Phantom, fichier `id.json`, clé privée, mot de passe Supabase, URL Redis privée ou `SESSION_SECRET` réel.
