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
