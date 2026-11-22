# GPUbnb DOGE — Étape 3 : remboursement HTLC et consensus natif (2026-11-22)

## Décision expérimentale : script-signature natif PASS, pas de fonds ni D8 physique

**Preuve positive exécutée** : [GitHub Actions #45063470360](https://github.com/khemisset18/gpubnb/actions/runs/45063470360), commit `f58ab2e4a3611e6bc3a643399206cc8803a21901`, journal et artéfact public. Le banc a :

1. Compilé `LedgerHQ/app-bitcoin-legacy@79f3036daec38347747fb498470bed3cfb103440` avec son sous-module épinglé et démarré l'application DOGE dans Speculos sans accès réseau ;
2. Créé **5 DOGE entièrement fictifs**, sans UTXO sur une chaîne, dans une entrée de financement P2SH aux octets synthétiques et demandé le remboursement **4,99 DOGE fictifs** avec **0,01 DOGE fictif de frais** ;
3. Obtenu de l'application Ledger émulée une signature du script P2SH-HTLC/CLTV avec `nLockTime=1351`, `nSequence=0xfffffffe`, `SIGHASH_ALL=1`. La signature ECDSA est valide et **low-S sur cet essai précis** ;
4. Conservé les **octets publics complets** du financement et de la transaction signée, puis **reconstruit indépendamment** les octets du `scriptSig`, de la transaction de remboursement, du redeemScript, du P2SH et du digest signé à partir de la bibliothèque de sérialisation D2 de GPUbnb ;
5. Téléchargé l'artéfact D0 de Dogecoin Core 1.14.9 (run `40866305437`, source et digests exacts), revérifié les identités D0/D1, les **attestations Sigstore** de provenance et de SBOM, puis extrait **uniquement** la bibliothèque `libdogecoinconsensus.so.0.0.0` à SHA-256 épinglé ;
6. Exécuté la bibliothèque native dans un namespace Linux **sans réseau** avec drapeaux `P2SH|DERSIG|CLTV=517`, ABI version 1, input index 0 ;
7. Obtenu **1/1 vérification native acceptée**, **11/11 mutations natives refusées** : valeur, destination, lock CLTV trop précoce, séquence finale, séquence non finale modifiée, transaction de financement différente, index de financement différent, redeemScript différent, branche de dépense incorrecte, octet de signature muté et type de sighash modifié.

**Preuve supplémentaire indépendante antérieure :** la qualification expérimentale du signataire logiciel externe [#45045597033](https://github.com/khemisset18/gpubnb/actions/runs/45045597033) a déjà produit et vérifié **trois remboursements signés et trois mutations** avec la bibliothèque native, toujours sans bloc/RPC/broadcast. Il ne faut pas additionner ces preuves comme un seul scénario réalisé sur le même contrat ou portefeuille.

**Limites formelles** : la bibliothèque native vérifie la satisfaction du script d'une transaction sérialisée **mais ne vérifie pas l'existence du UTXO, la finalité par rapport au tip, l'admission mempool, la politique de frais, la hauteur d'activation de la chaîne locale, ni une diffusion**. Le scénario Ledger a utilisé une application **DOGE mainnet** dans Speculos ; ce n'est pas une identification Regtest sur un appareil physique. L'émulateur n'affiche pas six champs critiques du refund. `D8=BLOCKED`, `D2=BLOCKED`, `D9=NOT_DONE`. Aucun DOGE réel et aucune clé utilisateur n'ont été utilisés.

## Gel contrôlable du profil logiciel expérimental

Le fichier `asset-exchange/qualification/dogecoin/d8/frozen_experimental_d2_profile_v1.json` garde les valeurs exactes exigées pour **cette expérience** :

- DOGE Regtest : genesis `3d2160a3b5dc4a9d62e7e66a295f70313ac808440ef7400d6c0772171ce973a5` ;
- Dogecoin Core 1.14.9 source `e0a1c157791544e818c901bd9341896965afbf9d`, bibliothèque `3c27dd2f3018a3bd659648129a94ba5f211e84b8ec6d308f7f0db001b5e7902b`, ABI 1 et flags 517 ;
- Remboursement de structure D2 legacy P2SH-HTLC SHA256, branche `OP_FALSE`, CLTV height 1351, séquence 4294967294 et SIGHASH_ALL ;
- Profil du **signataire logiciel de fixtures** `DOGE_REGTEST_LEGACY_P2SH_CLTV_SIGHASH_ALL_EXTERNAL_SOFTWARE_V1` ;
- Application de firmware émulée Ledger Legacy pin `79f3036daec38347747fb498470bed3cfb103440`, **identité réseau firmware DOGE mainnet**, pas Regtest ;
- Interdiction explicite de qualificatif matériel, fonds, diffusion, activation publique ou audit final.

Le test `test_frozen_experimental_d2_profile.py` confronte ce fichier aux constantes de l'implémentation **et** à une référence littérale figée. Une modification d'un champ doit déclencher un échec CI plutôt qu'un gel silencieusement déplacé. Ceci est un **gel de référence de laboratoire**, PAS le gel d'une implémentation matérielle approuvée en production.

## Prochain contrôle distinct à exécuter, si l'étape de chaîne locale est autorisée

Faire un scénario Dogecoin Core Regtest **avec de vrais blocs seulement dans un namespace isolé**, minage de coins sans valeur réelle, création d'un UTXO P2SH **confirmé**, vérification que le remboursement échoue avant la hauteur finale puis réussit **après** le lock CLTV, conformément à l'activation BIP65. Ce scénario nécessite son propre périmètre de RPC/minage et preuves de provenance. Le présent CI n'a pas miné de blocs : **ne pas lui attribuer de finalité ou de mempool PASS**.

**Aucun essai en DOGE mainnet, aucun transfert du portefeuille Trust Wallet et aucun merge de l'Asset Exchange.**
