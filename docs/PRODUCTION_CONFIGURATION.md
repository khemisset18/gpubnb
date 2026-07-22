# Configuration manuelle de production

Ne placer aucune valeur secrète dans Git, Netlify, le JavaScript public ou un
fichier d'exemple committé.

## Supabase

- Définir la **Site URL** sur le domaine HTTPS exact du frontend.
- Autoriser uniquement `<site>/auth.html`, `<site>/auth.html?next=publish` et
  `<site>/auth.html?mode=reset` comme redirections.
- Activer e-mail/mot de passe, confirmation d'e-mail et Google. Désactiver les
  inscriptions anonymes.
- Configurer SMTP avec SPF, DKIM et DMARC, puis personnaliser les modèles de
  confirmation, changement d'e-mail et récupération sans exposer l'existence
  d'un compte.
- Exiger au moins 12 caractères en production, activer la protection contre les
  mots de passe compromis et configurer Turnstile sur inscription/récupération.
- Pour le frontend servi par l'API, configurer `SUPABASE_URL` et
  `SUPABASE_ANON_KEY` : `/auth-config.js` est généré dynamiquement. Pour un
  frontend Netlify autonome, générer `apps/web/auth-config.js` depuis le fichier
  d'exemple avant publication. Le build Netlify génère automatiquement cette
  configuration depuis `SUPABASE_URL`, `SUPABASE_ANON_KEY` et
  `GPUBNB_API_URL`. Garder la clé `service_role` uniquement dans un
  coffre serveur; l'API actuelle n'en a pas besoin.
- Configurer `SUPABASE_URL` et `SUPABASE_ANON_KEY` côté API. Si le navigateur
  accède directement à des tables à l'avenir, activer et tester RLS avant cela.

## Google Cloud

- Créer un client OAuth Web dédié à chaque environnement.
- Déclarer uniquement l'origine HTTPS exacte du frontend.
- Utiliser comme redirect URI l'URL callback affichée par Supabase, sans joker.
- Publier/configurer l'écran de consentement et vérifier domaine, e-mail de
  support et politique de confidentialité.

## GitHub

- Protéger `main`, interdire les pushes directs et exiger chaque job de `CI`.
- Exiger une revue humaine, la résolution des conversations et une branche à
  jour; interdire le contournement des règles aux administrateurs.
- Limiter les permissions Actions en lecture par défaut et autoriser seulement
  les actions approuvées. Activer Dependabot et secret scanning.
- Les déploiements mainnet doivent utiliser un Environment protégé avec revue
  obligatoire. Ne jamais stocker de keypair Solana comme secret générique de PR.
- Gitleaks conserve une exception étroitement limitée à l'ancienne clé
  navigateur Supabase `anon` dans `apps/web/auth-config.js`. Cette exception ne
  couvre aucun autre chemin ni commit et ne doit jamais être élargie à une clé
  `service_role`.

## Render

- Créer PostgreSQL avec sauvegardes/PITR et Redis TLS. Renseigner
  `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `INTERNAL_SERVICE_TOKEN`,
  `PUBLIC_APP_DOMAIN`, `PLATFORM_WALLET`, `SUPABASE_URL` et
  `SUPABASE_ANON_KEY`.
- Conserver `ALLOW_MAINNET=false` et `ESCROW_PROGRAM_ID=NOT_DEPLOYED_YET` avant
  validation mainnet. Utiliser un RPC privé authentifié en mainnet.
- Le build utilise `apps/api/Dockerfile`; le healthcheck est `/health`. Vérifier
  `/ready` après migrations. Déployer d'abord sur staging et conserver l'image
  précédente pour rollback.
- Tester sauvegarde et restauration avant `prisma migrate deploy`. Ne jamais
  lancer `prisma migrate reset` en production.

## Solana et hôtes GPU

- Régénérer l'IDL après toute modification ABI, synchroniser le program ID et
  faire auditer le binaire déployé. Placer upgrade authority et trésorerie sous
  multisig matériel séparé.
- Fournir les rapports d'audit/pentest et preuves attendus dans `audit/evidence`
  avant d'envisager mainnet.
- Exécuter l'agent et le lanceur sous des comptes dédiés non-root. Utiliser un
  moteur rootless et un profil seccomp/AppArmor validé; ne jamais monter le
  socket Docker, le home fournisseur ou des secrets persistants.
- Autoriser uniquement un registre privé, exiger digest, scan Trivy, signature
  Cosign et SBOM. Configurer un kill switch externe et des alertes température,
  saturation, heartbeat, disque et réseau.

## Vérifications avant fusion

1. Tous les jobs de la PR sont verts et non ignorés.
2. Les migrations ont été appliquées sur une restauration représentative.
3. Inscription, confirmation, Google, Phantom, reset, liaison wallet,
   réservation et remboursement ont été testés sur staging.
4. Le build Docker et les scans ne signalent aucune vulnérabilité bloquante.
5. Le gate mainnet doit rester **NO-GO** tant que toutes ses preuves manquent.
