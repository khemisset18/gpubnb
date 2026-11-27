# Reproduire les essais privés Pearl

Les commandes partent de la racine d'un checkout complet du candidat de test `a595d3cf6f6a1ba1ddb112b0de4cdbb4b7bece65`. Les relevés de cette PR contiennent les identifiants réellement observés. Une nouvelle préparation crée de nouvelles clés éphémères et produira d'autres blocs et txid. Une reprise accepte seulement le hash retenu lors de la préparation originale.

## Binaires, sources et provenance

Sous Linux amd64, utiliser Go 1.26.10, Git, GPG, OpenSSL, Python 3.12 avec `cryptography`, Node 24 et PostgreSQL 16+. Le téléchargement des sources publiques est indépendant de l'exécution des nœuds privés.

```bash
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
export TMPDIR="$(mktemp -d)"
LAB="$(mktemp -d)"
REPO_ROOT="$PWD"
Q="$REPO_ROOT/asset-exchange/qualification/pearl/native"
E="$REPO_ROOT/docs/asset-exchange/research/2026-11-24/prl-native"
URL=https://github.com/pearl-research-labs/pearl
TAG=v1.5.8
PIN=3db05e0de0ca90c3a043abd927b968cf53bcd4c8
git clone --depth 1 --branch "$TAG" "$URL.git" "$LAB/pearl"
test "$(git -C "$LAB/pearl" rev-parse HEAD)" = "$PIN"
mkdir -m 700 "$LAB/gpg"
curl -fsSL https://github.com/web-flow.gpg -o "$LAB/web-flow.gpg"
gpg --homedir "$LAB/gpg" --import "$LAB/web-flow.gpg"
GNUPGHOME="$LAB/gpg" git -C "$LAB/pearl" verify-commit --raw "$PIN"
ARCHIVE=pearl-linux-amd64-v1.5.8.tar.gz
curl -fsSL "$URL/releases/download/$TAG/$ARCHIVE" -o "$LAB/$ARCHIVE"
curl -fsSL "$URL/releases/download/$TAG/checksums.txt" -o "$LAB/checksums.txt"
gh attestation trusted-root >"$LAB/roots.jsonl"
python3 "$E/verify_release.py" "$LAB/$ARCHIVE" "$LAB/checksums.txt" \
  "$E/release-bundle.jsonl" "$LAB/roots.jsonl"
tar -xzf "$LAB/$ARCHIVE" -C "$LAB"
NODE="$(find "$LAB" -type f -name pearld -perm -100 -print -quit)"
test "$(sha256sum "$NODE" | cut -d' ' -f1)" = bd025be5b17dbe9b1f224f5bd5aadd1bd74406073e956a7847dc9d07782bcca9
bash "$Q/build_helpers.sh" "$LAB/pearl" "$LAB/bin"
```

GitHub CLI 2.105.0 a fourni les racines signées des instances Sigstore publique et GitHub. L'empreinte attendue de la clé de commit est `968479A1AFF927E37D1A566BB5690EEEBB952194`. L'archive est vérifiée directement contre l'attestation du tag avec son instant RFC 3161. Les versions et empreintes sont dans [provenance.txt](provenance.txt).

## Chaînes privées et résultat indépendant

Lancer la préparation et la qualification dans cet ordre pour chaque réseau. La préparation s'arrête à 100 blocs et n'envoie aucun financement. L'engagement reste dans un journal séparé de la copie publique des transactions, créée avant financement. Le harnais relit cet engagement, puis vérifie le remboursement avant le premier envoi. Le script de qualification n'a besoin ni du programme de signature ni d'un portefeuille.

```bash
for NET in regtest simnet; do
  python3 -u "$Q/prepare_chain.py" --pearld "$NODE" --fixture-signer "$LAB/bin/fixture" \
    --network "$NET" --output "$LAB/$NET-material" >"$LAB/$NET-prepare.jsonl"
  H=$(python3 -c 'import json,sys; print(next(r["sha256"] for line in open(sys.argv[1]) if (r:=json.loads(line))["case"]=="recovery-intent-commitment"))' "$LAB/$NET-prepare.jsonl")
  python3 -u "$Q/qualify.py" --pearld "$NODE" --verify-refund "$LAB/bin/verifyrefund" \
    --network "$NET" --material "$LAB/$NET-material" --commitment "$H" \
    --fee-bump --fee-boundaries | tee "$LAB/$NET-result.jsonl"
done
sha256sum "$E/"*-refund.json
for capsule in "$E/"*-refund.json; do "$LAB/bin/verifyrefund" < "$capsule"; done
```

Lorsqu'une préparation est interrompue **après** l'écriture de la capsule et d'au moins un bloc complet, fermer le processus antérieur et reprendre la même chaîne avec son engagement déjà conservé. Le nœud neuf revalide les blocs et vérifie le premier coinbase avant de produire le suivant.

```bash
python3 -u "$Q/prepare_chain.py" --pearld "$NODE" --network regtest \
  --output "$LAB/regtest-material" --resume-commitment "$H_REGTEST"
```

## PostgreSQL, politiques du nœud et paramètres

Lancer le harnais depuis la racine d'Asset Exchange avec le chemin absolu du dossier bin du serveur. Avec le tarball source PostgreSQL 16.16 et un préfixe propre dans LAB, la compilation locale a utilisé ces options. Les sources et binaires à contrôler figurent dans [provenance.txt](provenance.txt).

```bash
curl -fsSL https://ftp.postgresql.org/pub/source/v16.16/postgresql-16.16.tar.bz2 -o "$LAB/postgresql-16.16.tar.bz2"
echo "9d5cd8633043b75740d5d59749c6b7365e6aeb53c47098b1a5e80bb18f87881a  $LAB/postgresql-16.16.tar.bz2" | sha256sum -c -
tar -xjf "$LAB/postgresql-16.16.tar.bz2" -C "$LAB"
(cd "$LAB/postgresql-16.16" && ./configure --build=x86_64-pc-linux-gnu \
  --prefix="$LAB/pg" --without-readline --without-icu --without-zlib && make -j4 && make install)
python3 "$REPO_ROOT/asset-exchange/db/test/prl_disposable.py" --pg-bin "$LAB/pg/bin"
(cd "$LAB/pearl" && CGO_ENABLED=0 go run -mod=readonly "$E/network_table.go")
(cd "$LAB/pearl" && CGO_ENABLED=0 go test -mod=readonly -count=1 ./node/txscript ./node/chaincfg ./node/mempool)
```

Les tests de politique amont construisent leur propre état UTXO. Leurs résultats et ceux du RPC de vrai nœud sont consignés séparément. Les commandes Node et Python figurent dans le [rapport PostgreSQL et API](../../../PEARL_PRL_POSTGRES_NATIVE_2026-11-24.md).

## Bibliothèque ZK amont et tests wire

Avec Rust et Cargo 1.100.0 et le compilateur C du système, la campagne a construit la bibliothèque amont avec les deux caches de circuits requis par cette révision. Le premier essai de `wire` en mode Go portable avait cinq échecs dans les tests de certificats. La campagne avec le tag `zkpow` exécute la suite complète de ce paquet. La politique de frais et les deux tests TLS sont comptés séparément. [Compilation des circuits](upstream-zk-build-cache.txt) · [Compilation FFI](upstream-zk-build-ffi.txt) · [Test natif amont](upstream-wire-zkpow.txt) · [Empreintes](upstream-zk-tools.txt)

```bash
(cd "$LAB/pearl/zk-pow" && cargo run --locked --release --bin build_cache \
    src/circuit/v2_cache.bin src/v1/v1_cache.bin)
(cd "$LAB/pearl/zk-pow/bindings/go" && cargo build --locked --release)
(cd "$LAB/pearl" && CGO_ENABLED=1 RAYON_NUM_THREADS=4 \
    go test -mod=readonly -count=1 -timeout=18m -tags zkpow ./node/wire)
(cd "$LAB/pearl" && CGO_ENABLED=0 go test -mod=readonly -count=1 \
    -skip '^Test(NewTLSCertPair|WriteTLSCertPair)$' ./node/btcutil)
(cd "$LAB/pearl" && CGO_ENABLED=0 go test -mod=readonly -count=1 \
    -run '^Test(NewTLSCertPair|WriteTLSCertPair)$' ./node/btcutil)
```
