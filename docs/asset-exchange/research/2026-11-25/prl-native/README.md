# Reproduire la qualification Pearl des 24 et 25 novembre 2026

Les deux campagnes utilisent le `pearld` Linux amd64 officiel v1.5.8, SHA-256 `bd025be5b17dbe9b1f224f5bd5aadd1bd74406073e956a7847dc9d07782bcca9`. Les commandes ci-dessous partent d'un checkout de la PR contenant ce dossier. La révision de code finale testée est `2fe74e7caa4a24ae19a4a937c178896564da5213`. Les preuves publiées ultérieurement sont consultables dans le checkout du rapport. [Sources, signature, téléchargements et commandes de compilation](../../2026-11-24/prl-native/REPRODUCE.md) · [Empreintes des pièces de cette campagne](SHA256SUMS)

## Nœuds de laboratoire et bénéficiaire distinct

Depuis la racine du dépôt, préparer les variables `REPO_ROOT`, `Q`, `LAB` et `NODE` selon la première section des commandes de compilation du 24 novembre. `LAB` doit désigner un nouveau répertoire privé. La compilation sur le code final produit trois outils Go. Le bénéficiaire annonce sa destination publique, vérifie le remboursement signé qu'il reçoit et présigne sa propre dépense. Les deux signataires quittent avant le financement. Chaque nouvelle préparation génère des clés de test, donc des txid et des blocs différents. Conserver séparément les deux engagements affichés par la préparation.

```bash
set -euo pipefail
E25="$REPO_ROOT/docs/asset-exchange/research/2026-11-25/prl-native"
export PYTHONDONTWRITEBYTECODE=1
bash "$Q/build_helpers.sh" "$LAB/pearl" "$LAB/bin"
for NET in regtest simnet; do
  python3 -u "$Q/prepare_chain.py" --pearld "$NODE" --fixture-signer "$LAB/bin/fixture" \
    --recipient-signer "$LAB/bin/recipient" --network "$NET" --output "$LAB/$NET-beneficiary" \
    >"$LAB/$NET-beneficiary-prepare.jsonl"
  python3 -u "$E25/exercise_fee_guard.py" --qualify "$Q/qualify.py" --network "$NET" \
    --pearld "$NODE" --verifier "$LAB/bin/verifyrefund" --material "$LAB/$NET-beneficiary" \
    --preparation "$LAB/$NET-beneficiary-prepare.jsonl" --output "$LAB/fee-checks"
done
python3 "$E25/check_public_inputs.py" "$LAB/bin"
for NET in regtest simnet; do
  "$LAB/bin/verifyrefund" --fee-quote <"$E25/$NET-refund.json"
done
(cd "$E25" && sha256sum -c SHA256SUMS)
```

Le test attend un code 1 quand l'observateur B annonce 11 000 ou 20 000 grains/kvB. Il vérifie l'absence de financement, la raison précise et la fin des deux nœuds. Au réglage standard de 1 000, le test exige le cycle complet jusqu'à la dépense du bénéficiaire puis exerce un relèvement de la politique sur deux observateurs supplémentaires. Les fichiers `.jsonl` sont la sortie standard brute. Les fichiers `.stderr` des refus attendus conservent le motif exact. Le contrôle hors ligne peut être répété sur les capsules et les dépenses publiques fournies ici.

Pour répéter la première expérience du bénéficiaire à `f0bd9f3c82c4154a3e30dcbd9b1191d1cfe3c7cf`, compiler ses trois outils, effectuer la même préparation, puis appeler `qualify.py` avec les deux empreintes de préparation et les options `--fee-bump --fee-boundaries --high-relay`. Le premier scénario et la répétition sur le code final emploient le même remboursement présigné par réseau. Les blocs générés après le financement peuvent différer. [Empreintes des premiers outils](go-tool-hashes.txt) · [Empreintes lors du contrôle avant financement](fee-guard-tools.txt)

## Revalider les mêmes blocs Regtest

L'archive du point de reprise contient les blocs publics 1 à 104 dans leur sérialisation Pearl, avec leurs certificats PoUW. Les fichiers portent leur hauteur et leur hash. Une seconde archive contient les blocs 105 et 106 d'une branche de récupération construite sur ce point de reprise. Les deux transactions présignées et les engagements sont publics. Le lecteur démarre son propre nœud officiel sur un répertoire vide, vérifie les 106 blocs, les deux dépenses et les UTXO obtenus à chaque hauteur. Le rejeu par défaut est passif. [Point de reprise](regtest-public-checkpoint.json) · [Blocs 1–104](regtest-public-blocks-001-104.zip) · [Blocs 105–106](regtest-public-blocks-105-106.zip)

```bash
(cd "$E25" && sha256sum -c SHA256SUMS)
python3 -u "$E25/replay_public_checkpoint.py" --pearld "$NODE" --verifier "$LAB/bin/verifyrefund"
# Pour créer sa propre continuation à partir des blocs 1–104 et des paiements présignés
python3 -u "$E25/replay_public_checkpoint.py" --pearld "$NODE" --verifier "$LAB/bin/verifyrefund" \
  --generate-continuation "$LAB/my-private-continuation.zip"
```

## PostgreSQL 16.16 et requêtes applicatives signées

Compiler ou installer PostgreSQL 16.16 comme dans le document du 24 novembre. Exécuter sous un compte local non privilégié avec Node 24. Le harnais démarre son propre postmaster, choisit sa base, crée ses identifiants et le détruit à la fin. Le pilote Node et les dépendances transitives sont épinglés dans le lockfile de laboratoire.

```bash
mkdir -m 700 "$LAB/pg-driver"
cp "$E25/pg-driver-package.json" "$LAB/pg-driver/package.json"
cp "$E25/pg-driver-lock.json" "$LAB/pg-driver/package-lock.json"
npm ci --prefix "$LAB/pg-driver" --ignore-scripts --no-audit --no-fund
python3 -u "$REPO_ROOT/asset-exchange/db/test/prl_disposable.py" --pg-bin "$LAB/pg/bin" \
  --node-pg-driver "$LAB/pg-driver/node_modules/pg/lib/index.js"
python3 -u "$REPO_ROOT/asset-exchange/db/test/prl_disposable.py" --pg-bin "$LAB/pg/bin"
```

Le journal PostgreSQL identifie le cluster par son identifiant système. Les tests vérifient les empreintes du catalogue et des lignes avant et après chaque rejeu DDL sur le même cluster. Les données synthétiques et les identifiants d'instance varient d'une exécution à l'autre. [Rapport PostgreSQL et suites Node/Python](../../../PEARL_PRL_POSTGRES_NATIVE_2026-11-24.md) · [Rapport blockchain et matrice de décision](../../../PEARL_PRL_REGTEST_NATIVE_2026-11-24.md)
