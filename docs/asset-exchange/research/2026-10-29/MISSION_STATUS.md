# Rapport factuel — sécurité Core et base technique Asset Exchange

**Mise à jour d'autorisation** : la mission élargie jointe par le propriétaire
après ce premier bilan autorise désormais le patch desktop, les prototypes Rust
isolés et le diagnostic DOGE D2 avec minage regtest strictement borné. Les limites
D3–D9, production et D0 restent en vigueur. Ce texte conserve le bilan historique ;
les nouvelles preuves sont dans `../../audits/DESKTOP_SECURITY_APPLIED_2026-10-29.md`
et `OFFLINE_RECOVERY_IMPLEMENTATION.md`, puis dans les PR distinctes de prototypes.

Date : 29 octobre 2026. PR de travail : https://github.com/khemisset18/gpubnb/pull/313
(brouillon, non fusionnée), basée sur #312. Aucun merge, changement direct de main,
déploiement, activation financière, Mainnet ni fonds réels. La nouvelle mission
jointe a été traitée comme une extension de recherche/documentation/tests hors
ligne et de correctifs CI limités, pas une autorisation générale du desktop ou
des composants financiers.

## TERMINÉ ET PROUVÉ

### Préservation D0 et D1

D0 reste le succès source-rebuild du run 40866305437, commit
99724d5b66b9475dcb96f6c471c75ce01ed60f9a, SHA-256 officiel
4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8.
Aucun fichier de qualification D0, workflow D0, snapshot/manifeste officiel ou
politique de confiance D0 n'est modifié par les derniers lots. La provenance
GPG des précompilés upstream reste un dossier distinct BLOQUÉ.

D1 reste le PASS isolé du run 40892872892, commit
1636df354d4fafd2cc2d9ab8595f4dca52582ad7, artifact 12906020927, ZIP SHA-256
18fecb1f6dd6dac59a44d44a351ddd7f70e378dd5f189a055d9af19c1002f13b.
Genèse exacte regtest, version 1140900, zéro pair/connexion, loopback uniquement,
wallet désactivé, allowlist du harness et arrêt propre sont prouvés. Ce vieux
nœud n'a pas d'ACL native par méthode ; cette limite est documentée. D0/D1
n'ont pas été reconstruits/réexécutés à la réception de la nouvelle mission.

### Correctifs réels déjà appliqués au Core autorisé

| Dépendance | Avant | Après dans les fichiers réels |
| --- | --- | --- |
| Fastify, deux locks | 5.12.1 | 5.12.7 |
| Zod | 3.25.76 | 4.6.7 |
| brace-expansion | 5.0.9 | 5.0.12 |
| fast-uri / AJV | 3.1.7 | 3.1.9 |
| fast-json-stringify / fast-uri | 4.1.4 | 4.2.3 |
| Jayson | 4.3.0 | 5.0.0 |
| @solana/web3.js | 1.98.4 | inchangé |
| PyNaCl | 1.5.0 | 1.6.2 |
| Rustls gateway | 0.23.43 | 0.23.46 |

Commits séparés : f0ef7390bb7fad81f319cfb78d23707a026bc799 (npm/Zod/Jayson),
61016d66b6616f339e06340054f534b6f9aabc1e (PyNaCl/Rustls). Fichiers :
package.json et package-lock.json racine/API, schéma diagnostics, tests API,
requirements racine/Agent, pyproject Agent, Cargo.toml/lock du gateway et
workflows de validation. Les modifications de schéma/erreurs restent strictes.
Aucun algorithme financier, logique de signature, contrôle d'accès ou garde
production n'est affaibli. Les tests n'utilisent aucun fonds de production.

### Résultats réels des suites et intégrations

Résultats CI au commit 3f178f65dc97e0a8e4882c116a14e39c9a4973fc :
https://github.com/khemisset18/gpubnb/actions/runs/40914795398 .
Les digests ZIP et comptes lus dans les vrais logs sont conservés dans
`../../audits/evidence/current-validation-20261029/ci-artifact-verification.json`.

| Contrôle | Résultat réel et limite |
| --- | --- |
| Node 22 npm ci, racine et API | PASS, arbres réels et scripts activés |
| npm audit, deux arbres, toutes sévérités | 0 info/low/moderate/high/critical ; PASS |
| TypeScript API build + strict noEmit | PASS |
| PostgreSQL + Redis | précontrôle réel puis tests d'intégration sur services CI jetables ; PASS |
| API | 701 tests : 699 PASS, 0 FAIL, 2 skips S3 préexistants dans cette suite |
| S3 dédié | les deux tests réellement exécutés : 1+1 PASS, zéro FAIL/skip ; couvre les deux scénarios omis dans la suite API standard |
| Agent | 447 tests : 446 PASS, 0 FAIL, 1 skip préexistant faute de binaires Rust dans ce job |
| Compatibilité Rust-ticket / Agent | le test omis ci-dessus réussit réellement dans le job gateway avec ses binaires fournis ; 1 PASS, zéro skip |
| Gateway + Redis | 37 tests Rust passent au total, plus Clippy, build release et image ; run 40914795515 PASS |
| Contract escrow | 7 tests unitaires PASS ; aucune qualification avec validateur Solana/production n'est déduite |
| Production guards, Gitleaks, P2P | PASS ; aucun seuil/exclusion nouveau |
| Asset Exchange enrichi localement | 171 tests sous Node 22 : 171 PASS, zéro FAIL/skip ; syntaxe PASS |

Les 171 comprennent les 150 tests initiaux, deux contrôles de fidélité des logs
et 19 nouveaux tests du modèle/catalogue. Ce sont des preuves hors ligne, pas
une qualification d'opérations de chaîne. Les checks de non-régression D0/D1
hors ligne restent dans le workflow Foundation ; aucun nouveau binaire DOGE
n'est exécuté par ces tests.

### P2P / journaux

Le gate git diff --check rejetait cinq lignes de deux journaux. Le commit
c343140682aae734dff125dd39f95798fe54ae14 conserve leurs octets originaux dans
des gzip déterministes, un mapping de hashes/numéros de lignes, le manifeste
D1 original et des vues normalisées. Les tests reconstituent les hashes originaux.
Le gate strict passe : run P2P 40914795554. Aucun contrôle n'a été neutralisé.

### S3 / MinIO

Cause initiale : minio/minio:latest non téléchargeable, avant les tests. Le
remplacement CI a été explicite : image MinIO maintenue par Chainguard,
index sha256:e234321fd3abff7fb968b0674056e883b702aa1ad93a0d4d795cb6c21fa46407,
plateforme amd64 sha256:abdbe7d805b4dc931053275bc65d6c96ea88e66fd121aa3bb87d7354ecd875c5.
Signature Sigstore et SPDX sont vérifiés contre l'identité exacte publiée par
le fournisseur ; scan réel de l'image : zéro vulnérabilité toutes sévérités.

Commits 3d6c623a23f3b0796006045406a5b3da92524eb4 et
3f178f65dc97e0a8e4882c116a14e39c9a4973fc. Le premier essai réel a révélé un
problème d'accès via NAT sur bridge interne ; il reste FAILED. Le harness
utilise désormais l'adresse privée inspectée du bridge, sans ouvrir le réseau.
Le run https://github.com/khemisset18/gpubnb/actions/runs/40914795552 réussit
put/get et migration avec zéro skip, puis nettoyage et conservation des preuves.
Artifact 12916145188, ZIP SHA-256
1539e295c7fe1b7ced3d4b51d2b771842899f7e606ec2ff2a047f1039869b17c.

## IMPLÉMENTÉ MAIS NON VALIDÉ EN CONDITIONS DE CHAÎNE

Le modèle de sécurité/reprise, les interfaces de données et le validateur de
catalogue sont implémentés dans asset-exchange/research, isolés de tout runtime
actif. Leurs scénarios adversariaux passent ; les booleans de confiance restent
des hypothèses de simulation. Il manque des validateurs cryptographiques,
executors, signers, outbox durable et tests de chaînes. COMPLETED dans le modèle
n'active aucune capacité et ne prouve aucune atomicité réelle.

## PRÉPARÉ SANS EXÉCUTION

Les lots A–C livrent 68 snapshots de fichiers de référence, versions/licences,
une matrice des dix paires et vingt directions, une comparaison DCRDEX/BasicSwap,
une architecture hybride candidate, une spécification de recovery/menaces/frais/
timeouts, une machine à états et une préparation juridique. La publication des
documents est terminée ; la conformité des protocoles décrits n'est pas prouvée.

Constats décisifs : XMR wallet DCRDEX ≠ swaps implémentés ; BasicSwap rejette
DOGE–XMR dans les deux sens et prépare par défaut un fork DOGE 23.2.1,
différent de notre v1.14.9 officiel ; BCH a un chemin covenant/sighash propre ; CLTV
DOGE regtest n'est pas prouvé à hauteur zéro ; SegWit DOGE est désactivé ; CSV
n'est pas qualifié. La sélection hybride ne couvre donc pas magiquement toutes
les paires. Aucun code cryptographique tiers n'est importé.

D2–D9 : feuille de route améliorée et brouillons précis RPC/réseau/ressources/
clés/minage/tests. Les méthodes ont été contrôlées dans les tables C++ v1.14.9 ;
testmempoolaccept n'y existe pas. Le commit d'un executor concret reste null,
car cet executor n'est pas implémenté/revu : aucune autorisation exécutable
fictive n'est présentée. Chaque phase devra recevoir son accord spécifique.

La préparation licence/réglementaire identifie les obligations et questions de
conseil ; le BOM transitive complet et la revue juridique indépendante restent
à faire. Logiciel non dépositaire ne signifie pas exemption réglementaire.

## BLOQUÉ

**Trivy global : 9 occurrences**, 2 HIGH, 5 MEDIUM, 2 LOW, zéro CRITICAL.
Run 40914795398/artifact 12915377617 ; toutes sévérités, dev inclus, sans
ignore-unfixed. Ces résultats priment sur l'ancien scan local cache à 3.

- borsh 0.10.4 / Anchor–Solana : GHSA-fjx5-qpf4-xjf2, MEDIUM.
- glib 0.18.5 / GTK–WebKit–Tauri : GHSA-wrw7-89jp-8q8g, MEDIUM.
- rand 0.7.3 / libsecp256k1–Solana : GHSA-cq8v-f236-94qc, LOW.
- source-map-js 1.2.1 : CVE-2026-93749, HIGH.
- Vite 7.3.6 : CVE-2026-112942 HIGH ; 112943/112944/112946 MEDIUM ; 112945 LOW.

Le patch desktop non appliqué propose Vite 7.3.7 et source-map-js 1.2.2. Sur la
copie isolée : npm ci, audit zéro, TypeScript et build Vite passent. Six offsets
source-map malformés sont rejetés. Un diagnostic strict fonctionnel sur des
maps indexées échoue ; la baseline officielle 1.2.1 présente les mêmes défauts.
Ce résultat demeure un échec documenté, pas un PASS masqué ni une régression
nouvelle prouvée. Validation Windows/native non réalisée sur le candidat.

Les contraintes Rust ont été vérifiées sur l'index Cargo officiel : pas de patch
compatible dans les séries sélectionnées. Anchor 1.2.2/borsh 1.x et la migration
libsecp256k1 nécessitent une revue ABI/sérialisation/crypto ; Tauri/Wry actuels
retiennent encore GTK/GLib 0.18. Le plan précise les prototypes/tests manquants ;
la migration majeure elle-même n'a pas été testée. Aucune exemption n'est ajoutée.

## NON COMMENCÉ / NON AUTORISÉ

Aucune exécution DOGE D2–D9, opération de wallet, minage, transaction ou signature
blockchain dans ces nouveaux lots. Aucun swap réel des dix paires, intégration
XMR active, signer matériel, Mainnet ou activation de règlement. LTC/XMR/BCH
restent non qualifiés ; BTC conserve son périmètre regtest déjà établi.
L'audit crypto indépendant, la décision juridique et le déploiement de l'exchange
ne sont pas réalisés.

## Prochaine décision exacte

Autoriser ou refuser l'application **des deux seuls fichiers desktop** proposés
(apps/host-desktop/package.json et package-lock.json), Vite 7.3.7 + override
source-map-js 1.2.2, avec audit/Trivy et validations frontend/Windows dans la PR
brouillon. Le patch et tous ses résultats, y compris le diagnostic en échec,
sont dans `../../audits/DESKTOP_SECURITY_PROPOSAL_2026-10-29.md`.

Une seconde décision distincte devra délimiter un prototype de migration
Anchor/Solana et/ou GTK/Tauri, avec comparaison ABI et revue des signatures,
sans changement financier de production. D2–D9 nécessitent chacune une autre
autorisation, seulement après gel d'un executor et de ses vecteurs vérifiables.
Aucun accord demandé ici n'inclut merge, déploiement, fonds ou activation.
