# Préparation de la publication GitHub (ne pousse rien automatiquement)

## Métadonnées recommandées

- **Nom :** `gpubnb`
- **Description :** `Devnet GPU rental marketplace with multi-identity auth, signed host telemetry and Solana Anchor escrow.`
- **Topics :** `gpu-marketplace`, `solana`, `anchor`, `typescript`, `fastify`,
  `prisma`, `postgresql`, `redis`, `phantom-wallet`, `docker`, `gpu-computing`
- **Visibilité :** privée jusqu'à validation juridique de `LICENSE`, du bundle
  frontend tiers et de l'historique par un scanner de secrets.

## Proposition de première Pull Request

**Titre :** `Prepare GPUbnb Devnet marketplace for security and architecture review`

**Corps :**

> ## Résumé
> - consolide les implémentations canoniques sous `apps/`, `agent/` et `programs/` ;
> - ajoute le modèle d'authentification multi-identité et les migrations additives ;
> - durcit sessions, CSRF, escrow, sandbox, Docker et contrôles CI ;
> - maintient la commission à 5 %, l'expiration à `endsAt + 3600` et Mainnet NO-GO.
>
> ## Validation requise
> - inspecter les résultats de chaque job CI sans ignorer de job ;
> - tester la migration sur une restauration de staging ;
> - tester les flux Supabase/Google/Phantom dans un environnement externe dédié ;
> - régénérer l'IDL et tester le binaire exact sur Devnet ;
> - ne pas fusionner avant revue sécurité et opérations.
>
> ## Limites
> Les capacités dépendant de Supabase, Google, Render, d'un RPC, d'un GPU/NVIDIA
> ou d'un audit externe ne sont pas attestées par les tests unitaires locaux.

## Résumé des commits locaux actuels

Utiliser `git log --oneline --decorate --reverse` comme source de vérité avant
publication. Ne pas recopier des SHA depuis un ancien rapport. Chaque futur
commit doit rester thématique : nettoyage/documentation, corrections produit,
puis résultats de validation reproductibles.

## Secrets et variables à configurer

Créer les secrets au niveau de l'environnement de déploiement plutôt qu'au
niveau global lorsque possible :

- `DATABASE_URL` (et `DIRECT_URL` seulement si le schéma Prisma l'utilise) ;
- `REDIS_URL` en TLS ;
- `SESSION_SECRET` et `INTERNAL_SERVICE_TOKEN`, indépendants ;
- `SUPABASE_URL` et `SUPABASE_ANON_KEY` (l'anon key n'est pas confidentielle,
  mais reste une configuration d'environnement) ;
- clé service-role Supabase uniquement si un futur job serveur l'exige ;
- identifiants Render uniquement pour un workflow de déploiement explicitement
  revu ;
- RPC Solana privé uniquement pour un environnement protégé.

Ne créer aucun secret contenant une seed phrase, une clé privée Solana ou un
fichier de deploy authority. Les clés Google restent dans Supabase/Google Cloud.
La CI de base ne doit dépendre d'aucun secret de production.

## Required checks proposés

Exiger les noms réels affichés après le premier run, couvrant au minimum :

1. API : npm clean install, Prisma format/validate/generate/migrate, typecheck,
   tests et build avec PostgreSQL/Redis de service ;
2. Rust : fmt, tests workspace et Clippy avec warnings interdits ;
3. frontend/Python/shell : syntaxe, tests, `py_compile` et ShellCheck ;
4. Docker : build de l'image canonique puis scan Trivy ;
5. secrets : Gitleaks sur l'historique et le diff ;
6. production gates : preuve que Mainnet reste NO-GO.

Un job annulé, ignoré ou neutralisé ne constitue pas un check vert.

## Protection de `main`

- Pull Request obligatoire, au moins deux approbations dont une CODEOWNER
  sécurité/contrat pour les zones sensibles ;
- dismiss stale approvals et conversation resolution obligatoires ;
- required checks stricts et branche à jour avant fusion ;
- signed commits/tags si l'organisation dispose de la chaîne de confiance ;
- interdiction des force-push, suppressions et accès direct hors break-glass ;
- administrateurs soumis aux mêmes règles ;
- déploiement production protégé par environnement et approbation manuelle ;
- secret scanning, push protection, Dependabot et CodeQL activés si disponibles.

## Checklist après le premier push

- [ ] Vérifier que le remote et la branche ciblent le bon dépôt privé.
- [ ] Inspecter Gitleaks et la recherche historique avant d'ajouter des secrets.
- [ ] Ouvrir la PR depuis la branche de travail, jamais directement sur `main`.
- [ ] Lire les logs complets de tous les jobs et corriger la première cause racine.
- [ ] Enregistrer les noms exacts des checks dans la protection de branche.
- [ ] Tester la migration sur une restauration anonymisée de staging.
- [ ] Configurer Supabase/Google avec les URI exactes de staging puis exécuter E2E.
- [ ] Construire, scanner, démarrer et arrêter réellement l'image Docker.
- [ ] Déployer/régénérer l'IDL uniquement sur Devnet et tester l'escrow complet.
- [ ] Confirmer que `scripts/mainnet-gate.sh` demeure NO-GO.
- [ ] Obtenir les revues humaine, sécurité, données et exploitation avant fusion.
