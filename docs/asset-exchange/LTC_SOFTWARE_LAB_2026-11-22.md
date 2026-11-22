# GPUbnb Litecoin — bilan initial du laboratoire gratuit (22 novembre 2026)

**Projet LTC en cours, non qualifié.** Cette branche crée une première couche de
contrôles logiciels hors ligne pour le profil
LTC_BASECHAIN_TRANSPARENT_V1, conformément à la spécification déjà présente
dans docs/asset-exchange/LITECOIN_ADAPTER_SPEC_V1.md.

## Résultats effectivement mesurés

La suite locale asset-exchange/qualification/litecoin/test_offline_preflight.py
a exécuté **39 méthodes unitaires, 39 PASS, 0 FAIL, 0 ERROR, 0 SKIP**.
Des mutations supplémentaires sont vérifiées dans les sous-tests, sans
les additionner comme des méthodes distinctes.

Les tests contrôlent :
- réseau fictif regtest Litecoin uniquement et domaines séparés BTC/DOGE/LTC ;
- exclusion de toutes les déclarations de chemins MWEB ;
- refus de signature, de financement, de diffusion, de fonds réels et d'une
  fausse qualification matérielle ou financière ;
- encodages JSON exacts sans doublons ;
- montants en litoshis, limites des frais, montant minimum du remboursement ;
- séquence, sighash ALL, hauteur de test et forme du script de destination
  public synthétique.

L'outil ne crée ni clé ni transaction, n'utilise aucun wallet et n'accède
pas à un nœud, à Internet ou à un service RPC. Aucun fonds réel n'est utilisé.

**Il ne prouve pas** l'authenticité de la source du JSON, le consensus natif,
la standardness, une transaction HTLC signable, le respect de MWEB par un
wallet, une récupération indépendante ou la finalité de chaîne. Un rapport
falsifié mais auto-cohérent reste possible.

## Étapes L0 à L9 et décisions

L0 et L1 : chaîne d'approvisionnement Litecoin Core, version, provenance
cryptographique, genesis et isolement natif — **non exécutés ici**.

L2 : refus logique des champs MWEB **PASS limité au validateur d'enveloppe**.
L'exclusion native des peg-ins, peg-outs, transactions et change MWEB
reste à démontrer.

L3 et L4 : scripts SegWit, CLTV/CSV, signatures et lock/redeem/refund —
**non exécutés ici**.

L5 : frais/dust/RBF/pinning — **non exécuté ici**.
L6 : bundle pré-lock et reprise sans backend — **non exécuté ici**.
L7 : watchers, désaccords et reorgs — **non exécuté ici**.

L8 : signataire matériel — **différé**.
L9 : audit indépendant — **différé**.

La qualification LTC reste BLOQUÉE, le registre reste MARKETPLACE_ONLY
et le règlement automatique reste interdit. Aucun effet sur DOGE ou BTC.
Aucun merge, déploiement, réseau public, vraie transaction ou changement
financier n'est autorisé par cette proposition.

## Suite prévue

1. Examiner la version officielle Litecoin Core v0.21.5.8 et authentifier
   intégralement la source et la distribution (L0).
2. Établir un laboratoire WSL2 **distinct** avec une seule interface loopback,
   sans wallet ni pairs publics, et relever la vraie identité regtest (L1).
3. Figer le script et l'identité LTC seulement après des expériences natives
   spécifiques en environnement autorisé (L2–L3).
4. Reproduire les campagnes L4–L7 uniquement avec UTXO synthétiques de regtest,
   permissions séparées pour toute signature ou diffusion locale.
5. Conserver L8–L9 en attente comme pour DOGE.

Cette documentation est un **bilan de qualification logicielle partielle**,
pas une autorisation d'échanger des LTC.

Références : docs/asset-exchange/ASSET_ACTIVATION_MATRIX_V1.md ;
https://github.com/litecoin-project/litecoin/releases/tag/v0.21.5.8.

## Complément L0 — contrôles reproduits sur Ubuntu WSL2, 22 novembre

Le compte rendu fourni par l'opérateur pour le worktree détaché
`4be5e58` consigne à nouveau **39/39 méthodes de préflight PASS,
0 FAIL**, dans `unshare --user --map-root-user --net`. Git affiche
`## HEAD (no branch)`, avec aucun fichier local modifié.

Une seconde commande lecture seule, effectuée par l'opérateur dans ce
worktree, a donné :

- Tag officiel distant `refs/tags/v0.21.5.8` :
  `ee2aea3fc3fd95213d1a041d561b52e07ae6dc63`.
- Ligne du manifeste `SHA256SUMS.asc` accessible par HTTPS :
  `43200c9f9d65ebc126ea5833ca9429e144c4b3273da6bb9f4e89fd7450ab1be9  litecoin-0.21.5.8-x86_64-linux-gnu.tar.gz`.

La lecture de l'objet tag GitHub public rattache ce tag annoté au
commit source `ec1b6489a900d09cf5991e220dce089c77a232a2`.
Il n'y a donc pas de contradiction entre les deux SHA.

**Portée : L0 REFERENCES_PUBLIEES_CONCORDANTES / BLOCKED.**
À cette étape, la signature PGP du manifeste n'a pas été vérifiée
indépendamment sur le poste ; ni la clé de signature, ni l'archive Linux
n'ont été authentifiées par comparaison cryptographique de leurs octets.
La publication d'une ligne SHA via HTTPS ne constitue pas, seule,
l'authentification de la distribution. Aucun binaire LTC n'a été exécuté.

La prochaine preuve L0 devra vérifier la signature PGP avec l'empreinte
de clé complète officiellement publiée, contrôler l'intégrité de
l'archive si téléchargée et enregistrer les identités sans modifier
les seuils de confiance ni activer LTC.

## Complément L0 — signature du manifeste PGP validée sur WSL2

Suite à l'exécution de l'opérateur, le manifeste
`https://download.litecoin.org/litecoin-0.21.5.8/SHA256SUMS.asc`
a été téléchargé et vérifié avec GnuPG dans un trousseau temporaire,
et la clé `davidburkett38-key.pgp` a été contrôlée contre l'empreinte
attendue, caractère pour caractère :

`D35621D53A1CC6A3456758D03620E9D387E55666`

Le journal présente :
- `Good signature from "David Burkett <davidburkett38@gmail.com>"` ;
- `[GNUPG:] VALIDSIG D35621D53A1CC6A3456758D03620E9D387E55666 ...` ;
- `L0 : SIGNATURE PGP VERIFIEE`.

L'avertissement `This key is not certified with a trusted signature`
est attendu dans le trousseau éphémère : il ne nie pas la validation
cryptographique, mais ne prouve pas à lui seul l'identité du titulaire
de la clé. L'empreinte complète a été comparée à une valeur de référence
fixée avant l'import de la clé.

**État mis à jour : L0 SIGNED_MANIFEST_VERIFIED / BLOCKED pour la clôture
L0 complète.** L'archive Linux elle-même n'a pas encore été téléchargée
ni comparée bit à bit au SHA-256 contenu dans le manifeste signé. Pas de
vérification indépendante de la provenance de la clé par un second canal
documentée. L1–L9 restent non qualifiés ou différés. Aucun exécutable LTC,
nœud, signature de transaction, broadcast ou fonds réels impliqué.

## Complément L0 — archive Linux contrôlée par SHA-256 sur WSL2

Après un premier essai bloqué par HTTP 404 (absence du répertoire
`linux/` dans l'URL), l'opérateur a téléchargé avec succès
`https://download.litecoin.org/litecoin-0.21.5.8/linux/litecoin-0.21.5.8-x86_64-linux-gnu.tar.gz`.
Le journal du contrôle affiche exactement :

```text
=== VERIFICATION SHA-256 ===
/tmp/tmp.JCnz1iJnhl/litecoin-0.21.5.8-x86_64-linux-gnu.tar.gz: OK
L0 : ARCHIVE CONFORME AU MANIFESTE SIGNE
```

SHA-256 retenu, conforme à la ligne vérifiée préalablement par PGP :
`43200c9f9d65ebc126ea5833ca9429e144c4b3273da6bb9f4e89fd7450ab1be9`.

**État actualisé : L0 archive hash PASS + manifeste PGP PASS, profil
LTC global toujours BLOCKED.** Le téléchargement corrigé utilisait
l'empreinte littérale fixée précédemment et signée, sans répéter la
vérification GPG dans le même shell ; la liaison à la signature repose
sur les deux journaux successifs. L'identité du propriétaire de la clé
n'a pas été établie par un canal indépendant dans ce rapport. L'archive
a été supprimée automatiquement après la vérification (trap temporaire).
Aucun binaire exécuté, nœud démarré, portefeuille ouvert, signature ou
diffusion de transaction.

Pour L1, la lecture de `src/chainparams.cpp` du commit upstream
`ec1b6489a900d09cf5991e220dce089c77a232a2` identifie les
**constantes candidates du regtest Litecoin** suivantes, sans prouver
encore l'identité d'un nœud exécuté :

- genesis : `530827f38f93b43ed12af0b3ad25a288dc02ed74d6d7857862df51fc56c416f9`;
- message-start : `fa bf b5 da`;
- port pair-à-pair par défaut : `19444`;
- HRP Bech32 transparent : `rltc`.

L1 reste NON QUALIFIÉ tant que la configuration d'un nœud réellement
isolé, ses paramètres et l'observation réseau n'ont pas été vérifiés.

## Complément L1 — contrôle statique des paramètres regtest sur WSL2

L'opérateur a exécuté un contrôle Python, sans exécuter Litecoin Core,
sur la version de `src/chainparams.cpp` récupérée en HTTPS à partir du
commit source figé `ec1b6489a900d09cf5991e220dce089c77a232a2`.
La commande compare les constantes extraites de `CRegTestParams`
à des valeurs attendues prédéfinies et affiche :

```text
L1 : PARAMETRES REGTEST SOURCE OK
Genesis : 530827f38f93b43ed12af0b3ad25a288dc02ed74d6d7857862df51fc56c416f9
P2P : 19444 | Bech32 : rltc | Magic : fabfb5da
```

Ce contrôle démontre une **concordance statique** pour les constantes
regtest `genesis`, `pchMessageStart`, `nDefaultPort` et `bech32_hrp`
dans ce fichier source précis.

**L1 statut : STATIC_SOURCE_PARAMETERS_PASS / NATIVE_NETWORK_BLOCKED.**
Il n'y a pas d'attestation de nœud en fonctionnement, de binaire
effectivement chargé, de namespace réseau effectif pour un démon, de
mauvais réseau refusé par RPC ou d'isolation native. L2–L7 restent à
qualifier indépendamment ; L8/L9 restent différés. Aucune transaction,
signature ou diffusion n'a été effectuée.

## Complément L2 — préfixes LTC transparents / MWEB et adresse Bech32 v0

L'opérateur a contrôlé dans le fichier amont
`src/chainparams.cpp` du commit source
`ec1b6489a900d09cf5991e220dce089c77a232a2`, en lecture seule,
les constantes du regtest :

```text
L2 : IDENTITES TRANSPARENT / MWEB DISTINCTES
Transparent : rltc
MWEB        : tmweb
MWEB existe dans le profil regtest : exclusion obligatoire
```

La distinction des HRP est un contrôle de source statique : cela ne
prouve pas que les chemins MWEB du wallet, du nœud, d'un peg-in/peg-out,
d'un UTXO ou d'un remboursement complet seraient refusés.

Une nouvelle fonction autonome
`asset-exchange/qualification/litecoin/transparent_address_guard.py`
refuse par défaut toutes les chaînes non reconnues comme **adresses
Bech32 SegWit v0 transparentes `rltc`** à checksum valide et encodage
canonique : autres réseaux, préfixe `tmweb`, mauvais checksum,
mauvais programme, version de témoin autre que 0 et caractères
non conformes. Elle retourne toujours des indicateurs
`qualified=false`, `mwebExcludedInFullTransaction=false`,
`canSign=false`, `canBroadcast=false`. Il s'agit d'une
classification de chaîne de caractères, non d'un décodeur de
transaction Litecoin ni d'un validateur natif du protocole MWEB.

**22/22 tests supplémentaires PASS dans l'environnement local de
construction isolé**, y compris vecteurs de contrôle P2WPKH/P2WSH
publics et mutations. Les tests complémentaires ne sont pas encore
attestés par Ubuntu WSL2 de l'opérateur ; après récupération de la
branche de travail, le nombre attendu sera 61 méthodes distinctes
(39 préexistantes + 22 nouvelles).

**L2 statut : SOURCE_HRPS_PASS + ADDRESS_SHAPE_GUARD_PASS /
NATIVE_MWEB_REJECTION_BLOCKED.** L0 source/distribution partiellement
prouvée, L1 réseau natif non exécuté, L3–L7 non qualifiés, L8–L9
différés. Aucun ajout au registre de règlement, aucune clé, signature,
transaction, RPC ou diffusion.

## Complément L2 — 61/61 tests reproduits sur Ubuntu WSL2

Le compte rendu fourni par l'opérateur pour le worktree LTC séparé rapporte :

```text
HEAD is now at a327f02 docs(ltc lab): explain 22 address guard tests and WSL2 run
Ran 61 tests in 0.057s
OK
=== ETAT GIT LTC ===
## HEAD (no branch)
```

**Résultat : 39/39 tests du précontrôle initial + 22/22 tests de
classification d'adresses Bech32 v0 = 61/61 méthodes unitaires distinctes
PASS sur Ubuntu WSL2**, exécutées via
`unshare --user --map-root-user --net` et
`PYTHONDONTWRITEBYTECODE=1`. Aucun fichier local modifié.
Le commit testé `a327f029bf8fe653620b9aebd14e2bb3ea03aa9c`
contient tous les contrôles mentionnés ; les ajouts ultérieurs de
documentation à la PR n'altèrent pas les fichiers de test.

**Portée : contrôles d'enveloppe et d'adresses publiques uniquement.**
Aucun script HTLC Litecoin ni dépense/redeem/refund native testée,
aucun RPC, nœud, wallet, matériel, signature ou diffusion.
L'exclusion native de MWEB reste bloquée, et les qualifications
L1–L9 complètes restent non acquises.

## Complément L3 — présence statique des primitives dans Litecoin Core

L'opérateur a exécuté un contrôle Python, en lecture seule, de la
source `src/script/interpreter.cpp` du commit amont figé
`ec1b6489a900d09cf5991e220dce089c77a232a2`. Le journal affiche :

```text
L3 : CLTV SOURCE OK
L3 : CSV SOURCE OK
L3 : SegWit v0 SOURCE OK
L3 : Verification witness SOURCE OK
L3 : Calcul sighash SOURCE OK
L3 : CONTROLE STATIQUE TERMINE
```

Cette vérification prouve uniquement la **présence des cinq marqueurs**
textuels dans le fichier source demandé. Elle ne teste pas leur
activation par flags, les refus natifs aux bornes CLTV/CSV, la
validation de signatures, les scripts/witness stacks, le consensus, le
sighash concret d'un HTLC, ni l'intégration GPUbnb.

**L3 état : SOURCE_MARKERS_PASS / NATIVE_SCRIPT_QUALIFICATION_BLOCKED**.
Le dernier bilan logiciel exécuté sur WSL2 reste **61/61 PASS**.
Toujours aucun wallet, nœud, signature, diffusion ou fonds réels.
