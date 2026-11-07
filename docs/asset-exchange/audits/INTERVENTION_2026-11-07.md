# GPUbnb Exchange — intervention du 7 novembre 2026

## Périmètre et résultat

Mission globale non terminée. Cet incrément corrige deux classes de défauts démontrés, ajoute une première validation d'identité Pearl et revalide les suites disponibles. Il ne constitue pas un audit exhaustif du dépôt ni une qualification financière.

Base exacte : `1f0a098c06552d5e53ea091a2a85b7ce8cc876d2` (PR #334). PR #312, #314, #318, #320, #334 consultées. Les travaux de #318 → #320 → #334 sont conservés via leur historique. Les preuves D0/D1 historiques ne sont pas réattribuées à cette exécution.

`a96cdd96`, `d4c2c291`, `8ddcfbe3e2ca9bdbca2ea0c68a41ea3dabf307fb` : absents du clone et réponses GitHub 422 « No commit found ». Aucun ZIP/patch disponible dans les pièces jointes ou le workspace initial. Leur récupération reste BLOCKED ; aucune ancienne version n'a remplacé les fichiers courants.

## Corrections et preuves

- Watchers : un retour anticipé UNCERTAIN masquait des conflits ultérieurs ; une observation unique CONFLICTED était CONSISTENT ; une première observation non confirmée masquait deux inclusions contradictoires. Comparaison désormais indépendante de l'ordre, contradictions de hauteur recherchées pour chaque hash. Cinq nouveaux tests échouent avant et passent après, avec toutes les permutations. Portée : cohérence des observations fournies, pas authenticité des producteurs.
- API : 12 000 tableaux imbriqués dans une entrée de 24 001 octets déclenchaient RangeError/stack overflow. Limite de 32 conteneurs avant récursion et limite de 1 MiB UTF-8 avant parsing, y compris appels directs. Trois régressions échouent avant et passent après. La limite HTTP existante de 64 KiB reste applicable par défaut.
- Pearl : profils source des six réseaux et validation exacte des champs propres sans getter. Les 30 substitutions entre réseaux sont rejetées. Regtest et Simnet ont le même genesis ET HRP : aucun de ces deux éléments ne suffit à identifier le réseau. Le magic réseau et le nom explicite sont requis. Signet limité aux paramètres par défaut ; pas de qualification Bech32m/Taproot, RPC, consensus ou règlement. Les observations restent non authentifiées.

Source Pearl : `pearl-research-labs/pearl@0dbdb2ffd8b81193a5079bb67a59aecc10ad501c`. Empreintes des quatre fichiers consultés dans `asset-exchange/chain-watchers/fixtures/pearl-source-identity.json`. Conversion little-endian des genesis vérifiée contre `chainhash.Hash.String()` ; pas de calcul natif indépendant du genesis.

## Tests exécutés

Runtime : Linux, Node v24.22.1, Python 3.12.14. La CI du dépôt cible Node 22 : aucune équivalence de version n'est présumée.

| Contrôle | Statut | Résultat |
|---|---|---|
| Suite Exchange avant | PASS | 257/257, 0 échec, 0 ignoré |
| Suite Exchange finale | PASS | 269/269, 0 échec, 0 ignoré |
| Syntaxe | PASS | 51 sources |
| DOGE D0 logiciel/preuves | PASS | 31 tests ; pas de rebuild natif |
| DOGE D1 logiciel/preuves | PASS | 11 tests ; pas de nouveau nœud |
| DOGE D2 hors ligne | PASS | 74 tests ; pas de signature native |
| Isolation réseau locale | BLOCKED | unshare --net : Operation not permitted ; user namespace : uid_map inaccessible |
| DOGE D2 qualification native | BLOCKED | Aucun binaire Dogecoin exécuté |
| Intégration PostgreSQL Exchange | NOT_TESTED | Aucun service DB provisionné |
| Audit de sécurité complet | NOT_TESTED | Revue ciblée seulement |
| Activation Mainnet | NOT_TESTED | Aucune activation ni transaction |

Les logs avant/après et SHA256SUMS sont dans `evidence/2026-11-07/`. Ils permettent de distinguer les régressions démontrées des contrôles déjà passants. Les tests de journal/crash logiciels de la suite Node ne prouvent pas la récupération de fonds réels.

## DOGE D2 : obstacle et preuves manquantes

Le runner ne permet pas de créer le namespace réseau exigé. Aucun contournement par désactivation de l'isolation. Les binaires et attestations D0 ne sont pas revalidés dans cette session ; le harnais de diagnostics existant ne couvre pas à lui seul le D2 complet.

Restent : exécuteur natif complet figé ; fixtures signées à deux clés distinctes ; claim/refund positifs et négatifs ; flags exacts ; IsStandardTx/AreInputsStandard ; mempool sous standardness imposée ; UTXO, finalité et conflits ; reorg/crash/recovery indépendants ; provenance et empreintes des preuves. Le comparateur existant conserve BLOCKED même si des déclarations de résultats correspondent. L'autorisation utilisateur est acquise pour les tests privés ; le blocage actuel est technique, pas une demande de consentement supplémentaire.

D3, D4, D5, D6, D7, D8, D9 : NOT_TESTED dans cette session. Aucun passage de phase déclaré.

## Autres composants

| Composant | Statut | Limite |
|---|---|---|
| Bitcoin natif et BTC↔DOGE | BLOCKED | Pas de binaires/nœuds isolés exécutés ; scripts historiques non requalifiés |
| ZEC_TRANSPARENT_V1, ZIP244 | NOT_TESTED | Travaux locaux cités indisponibles ; pas de nouvelle implémentation ZIP244 |
| Monero cross-curve/adaptor | NOT_TESTED | Aucun protocole ni primitive ajouté ; pas d'audit cryptographique |
| Pearl validation des identités source | PASS | Tests logiciels uniquement |
| Pearl RPC/watchers/reorg/refund | NOT_TESTED | Non implémentés dans cet incrément |
| Backend, worker, recovery existants | PASS | Suite logicielle seulement ; pas de service déployé ni intégration financière |
| Wallet-agent / UI financière | NOT_TESTED | Aucun développement de ces composants ici |
| Régression GPUbnb générale | BLOCKED | Voir branche séparée des dépendances et ses échecs d'environnement |

## Les 20 directions financières

Toutes restent BLOCKED (qualification de sécurité/native absente). Aucun statut logiciel ne les active.

| De \ Vers | DOGE | BTC | ZEC | XMR | PEARL |
|---|---|---|---|---|---|
| DOGE | — | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| BTC | BLOCKED | — | BLOCKED | BLOCKED | BLOCKED |
| ZEC | BLOCKED | BLOCKED | — | BLOCKED | BLOCKED |
| XMR | BLOCKED | BLOCKED | BLOCKED | — | BLOCKED |
| PEARL | BLOCKED | BLOCKED | BLOCKED | BLOCKED | — |

## Dépendances, CI et protections

Mises à jour npm dans une branche séparée `security/shared-dependencies-20261107` ; aucun lockfile partagé dans cette branche Exchange. Rapports npm et résultats de build/régression dans le rapport de cette branche. Borsh 0.10.4, glib 0.18.5, rand 0.7.3 restent à analyser/corriger dans l'arbre Rust actif ; absence de cargo local et compatibilités ABI/SBF/GTK non qualifiées. La revue historique I décrit les parents actifs et la divergence d'avis Borsh. Aucun finding écarté et aucun seuil CI abaissé.

Aucun workflow modifié. Push autorisé après inspection des triggers : CI générale de tests, aucune publication financière sur ces branches. La PR Exchange ne touche pas les chemins déclenchant Bitcoin Regtest/Signet ; DOGE D2 reste dispatch-only. Les résultats CI distants doivent être consultés sur la tête publiée, jamais déduits des tests locaux.

Aucune fusion main/dev, aucun déploiement, fonds réels, suppression de données ou changement métier de location. L'approbation finale reste requise pour fusion, production financière et opérations réelles. Fournir les trois commits/patchs absents et un runner Linux à namespaces permettra la reprise des travaux bloqués.

## Fichiers et commits locaux

- `asset-exchange/api/src/strict-json.mjs`
- `asset-exchange/api/test/strict-json.test.mjs`
- `asset-exchange/chain-watchers/fixtures/pearl-source-identity.json`
- `asset-exchange/chain-watchers/src/evidence.mjs`
- `asset-exchange/chain-watchers/src/pearl-network.mjs`
- `asset-exchange/chain-watchers/test/evidence.test.mjs`
- `asset-exchange/chain-watchers/test/pearl-network.test.mjs`

17b2508c feat(exchange): pin Pearl source identities and reject network substitution
93a9ba94 fix(exchange-api): bound strict JSON recursion and input bytes
7953d6bf fix(exchange): preserve conflicts across all watcher observations

Ce rapport et son dossier de preuves sont ajoutés dans un commit documentaire séparé. La publication via API peut produire des SHA différents ; les arbres doivent être comparés avant livraison.
