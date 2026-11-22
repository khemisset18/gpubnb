# Reçus du candidat DOGE 17bb — 21 novembre 2026

Référence publiée : 17bb3e2e7774d97538305759e706de6f6a8da0d1.
Arbre testé : 4fb75f3aab95895b8d841e240932cad083687fc6.
Merge virtuel de PR identique : 898ea2c01b96e56e8c375faf6d4c3323a2895b67.

Le rapport de décision est [DOGE_INTERNAL_CANDIDATE_2026-11-21.md](../../../DOGE_INTERNAL_CANDIDATE_2026-11-21.md).
Ce dossier est ajouté après le candidat : ses fichiers ne sont pas présentés
comme présents dans l'arbre déjà testé ni dans son archive source.

- github-actions-result.json : 12 workflows SUCCESS, 35 jobs PASS, 5 SKIP manuels.
- artifact-verification.json et artifact-semantic-verification.json :
  archives téléchargées, SHA/CRC, sommes internes, source/lock/pins et portée.
- ci-artifacts.json : Trivy 0constat, npm0aux deux racines, API706 PASS/2 SKIP.
- trivy-results.json, npm-audit-root.json, npm-audit-api.json,
  api-test.log et integration-preflight.log : originaux du candidat.
- anchor-sbf-report.json et anchor-host-*-report.json : originaux CI.
- architecture-final-handoff.json : provenance GTK, GUI réelle et source exacte.
- official-security-result.json : advisories officiels recontrôlés, résolution.
- source-result.json, source-build-a.log, source-build-b.log,
  source-verification.log et source-SHA256SUMS : deux constructions locales
  identiques du périmètre source721 fichiers ; aucune nouvelle attestation OIDC.
- criteria.json : grille D0–D9 et distinction contrôle interne/audit externe.
- model-code-traceability.md : carte de revue, sans revendication de raffinement
  mécanisé complet ni répétition des modèles inchangés.
- s3-selected-log.txt : extraits du job MinIO réel, explicitement des extraits.
- SHA256SUMS : tous les fichiers de ce dossier, sauf ce manifeste lui-même.

Les archives complètes se trouvent dans les artefacts des exécutions référencées.
Le rapport Windows original conserve ses fins de ligne CRLF dans les objets Git,
afin que son empreinte reste celle du fichier téléchargé.
Les ZIP vérifiés sont énumérés avec identifiants et empreintes ; aucun lien signé
temporaire, secret ou clé privée n'est commis. Les installateurs sont des builds
de développement non signés ; aucun déploiement n'a eu lieu.

Vérification locale : depuis ce dossier, exécuter sha256sum --check --strict SHA256SUMS.
