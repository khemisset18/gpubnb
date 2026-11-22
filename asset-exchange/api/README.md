# Asset Exchange API — état du code source

**Sécurité : aucun déploiement ni usage financier qualifié par ce document.**

Le texte précédent décrivait un jalon historique G5 sans routes métier,
mais il ne correspond plus à l'arborescence réellement présente.
Il est conservé ici comme indication historique, non comme état courant.

## Modules présents dans les sources

- src/server.mjs : serveur HTTP avec validation Host, contrôles des
  en-têtes critiques, réponses JSON et délais.
- src/routes.mjs : code des routes pour les sessions, le catalogue
  des actifs, la publication/annulation/acceptation d'offres et
  l'administration des politiques de frais.
- src/session.mjs, src/sso-ticket.mjs, src/authz.mjs :
  logique de session, SSO et autorisation.
- src/offer-service.mjs : validation des offres, vérification externe
  de signatures et accès au dépôt, avec garde de qualification PRL
  avant ces vérifications/écritures.
- src/postgres-*-repository.mjs : adaptateurs PostgreSQL.
- src/rate-limit.mjs et src/strict-json.mjs : contrôles de débit
  et d'entrée.

Les migrations et les tests sont dans les dossiers db/ et api/test/.
Les fonctionnalités disponibles **dans le code** ne démontrent pas
qu'un service est déployé, activé, testé avec la DB réelle ou prêt
à recevoir des utilisateurs.

## Frontières obligatoires

- Aucun accès aux bases ou identifiants du Core GPUbnb.
- Aucun secret, seed, clé privée ou wallet côté Exchange API.
- Aucune transaction ou diffusion blockchain depuis cette API.
- Toute publication/acceptation nécessite une identité canonique
  de l'actif et la politique d'activation correspondante.
- Ne pas confondre MARKETPLACE_ONLY avec le droit de publier une offre.
- Pearl PRL : identité non vérifiée, nouvelles offres désactivées,
  aucune route de règlement, contrôle fail-closed avant signature
  ou dépôt. Une offre déjà stockée ne doit pas être acceptée
  sans politique de qualification atomique de son identité.

## Non qualifié dans cette branche

Déploiement public ; sessions réelles et politique de révocation
multi-instance ; contraintes de base PostgreSQL en environnement
réel ; anti-rejeu inter-instances ; contrôle des offres historiques ;
provenance Pearl et consensus natif ; audit indépendant.

Consulter :
- docs/asset-exchange/PEARL_PRL_EXCHANGE_ARCHITECTURE_SECURITY_2026-11-23.md
- docs/asset-exchange/PEARL_PRL_MARKETPLACE_SECURITY_REVIEW_2026-11-23.md
