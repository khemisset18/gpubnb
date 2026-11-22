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
