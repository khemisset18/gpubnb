# GPUbnb — D8 à zéro euro : décision de sécurité documentée (22 novembre 2026)

**Décision finale de cette revue : parcours logiciel Regtest entièrement exercé en laboratoire et vérifié, mais D8 physique/H8.1–H8.5 NON QUALIFIÉ.** Il serait dangereux d'afficher « D8 PASS » en contournant ou en redéfinissant les exigences sans revue indépendante. Aucune dépense, aucun DOGE réel ni aucune mise en production.

## Preuves vérifiables obtenues par nous

| Couche de sécurité | Preuve reproductible | Résultat et périmètre |
| --- | --- | --- |
| Signature DOGE P2PKH et HTLC | [Ledger Speculos, run #45063733044](https://github.com/khemisset18/gpubnb/actions/runs/45063733044) | PASS en émulation ; firmware DOGE mainnet, pas d'appareil réel |
| Vérification de la signature HTLC par le moteur natif Dogecoin | [Run #45063733044](https://github.com/khemisset18/gpubnb/actions/runs/45063733044) | Exact scriptSig de signature émulateur accepté, onze mutations refusées, Dogecoin Core 1.14.9 à provenance D0 attestée ; aucune preuve de financement sur chaîne pour cette signature |
| Contrôle de 17 modifications de demande AVANT signature | [Run #45062308438](https://github.com/khemisset18/gpubnb/actions/runs/45062308438) | Contrôles de **l'application hôte** PASS ; pas des refus d'un appareil matériel |
| **Chaîne DOGE Regtest locale financée, vraie confirmation, remboursement après échéance, interruption/reprise** | [Run #45064356615](https://github.com/khemisset18/gpubnb/actions/runs/45064356615) | **PASS** ; 95 tests D2, réseau exclusivement local, clés jetables OpenSSL, financement et remboursement de blocs privés, CLTV, non-finalité anticipée, crash et sauvegarde, réorganisation/reprise ; **pas la même signature que celle de Ledger** |
| Source et dépendances | [Run #45064356615](https://github.com/khemisset18/gpubnb/actions/runs/45064356615) | Source D2 gelée par hashes et diff, D0/D1 vérifiés et attestations Sigstore revérifiées, budget 1 nœud / 1360 blocs / 180 RPC local seulement |
| H8 matériel | [Procédure de passage](https://github.com/khemisset18/gpubnb/blob/95b483580f228318aa1e5305e4f295746b6cee21/docs/asset-exchange/DOGE_D8_PREPHYSICAL_HANDOFF_2026-11-22.md) | **BLOCKED** : H8.1–H8.5 non réalisés sur appareil matériel compatible |

Le rapport du Regtest local classe explicitement l'expérience `PRIVATE_FUNDED_DOGE_REGTEST_SOFTWARE_EXPERIMENT_PASS_D8_HARDWARE_BLOCKED`, avec D2/D8 BLOQUÉS, et ne doit jamais être promu. Les transactions du laboratoire ne sont pas des transactions réseau public et n'impliquent aucun portefeuille réel.

## Options concrètes recherchées à budget strictement nul

### 1. Utiliser directement le Trust Wallet DOGE de l'utilisateur — **NON QUALIFIÉ**

Il reste approprié à la garde de DOGE et aux transferts classiques, pas à la qualification du profil Regtest P2SH-HTLC/CLTV. La documentation officielle Trust Wallet d'intégration mobile WalletConnect indique les réseaux EVM et Solana, sans interface de transaction arbitraire Regtest DOGE confirmée : https://github.com/trustwallet/developer/blob/master/develop-for-trust/mobile/mobile.md . **Ne jamais inférer une prise en charge de HTLC à partir du support général Dogecoin.** Ne demander ni seed, ni transfert, ni mise à disposition de fonds réels.

### 2. Logiciel de signature autonome et séparé + Regtest — **MEILLEUR CHOIX À 0 €**

L'architecture Regtest actuelle permet les preuves financées, script/consensus, récupération après crash et mutations. Le signataire externe de fixtures est séparé et n'extrait aucune clé du wallet réel. Cette solution est la seule déjà **exercée avec preuves** sans dépendance matérielle. On peut l'améliorer en conservant les reçus de termes indépendants, une revue lisible et un refus par défaut ; cela n'apporte pas l'isolation certifiée des secrets et de l'écran sur appareil physique. Doit rester une **qualification logicielle différente de D8 matériel**.

### 3. Ledger Speculos ou émulateur Trezor gratuits — **OUTILS LOGICIELS, PAS MATÉRIEL**

Ledger dit explicitement que Speculos ne garantit pas un comportement identique à l'appareil physique ni les isolations de son système d'exploitation : https://github.com/LedgerHQ/speculos . Trezor documente de même son émulateur : https://docs.trezor.io/trezor-firmware/core/emulator/index.html . Leur émulation n'est pas une observation H8.2 sur un appareil réel. Le Ledger Legacy DOGE observé dans nos traces n'affiche pas les six conditions de contrat Regtest/refund/CLTV/sequence/outpoint/redeem. **Passer les tests Speculos n'autorise pas à accepter une signature aveugle.**

### 4. Transformer le smartphone existant en wallet matériel — **NON PROUVÉ**

Un logiciel sur téléphone est gratuit, mais Android StrongBox/Keystore s'appuie sur des courbes NIST P-256 pour ECDSA dans l'implémentation sécurisée standard : https://developer.android.com/privacy-and-security/keystore . Apple Secure Enclave indique également NIST P-256 : https://developer.apple.com/documentation/Security/protecting-keys-with-the-secure-enclave . **DOGE demande secp256k1**. Des clés logicielles secp256k1 sur smartphone ne deviennent pas matériellement isolées par l'existence d'un Secure Enclave P-256 ; une éventuelle protection P-256 d'une confirmation distincte ne prouverait ni la protection de la clé DOGE ni une approbation exacte sur le matériel. Ne pas attribuer H8.1–H8.5 à cette architecture sans conception, attestation et revue spécifique.

### 5. Un vrai wallet matériel compatible déjà disponible gratuitement — **SEULE VOIE COURANTE VERS H8 PHYSIQUE**, mais **compatibilité encore non établie**

Un modèle existant, emprunté gratuitement ou fourni, **pourrait** permettre D8 sans achat, **uniquement** si une revue de son firmware et des preuves sur son écran montrent effectivement tout le profil DOGE Regtest legacy P2SH HTLC CLTV. Les options Ledger/Trezor standards documentées ne le prouvent pas. Trezor distingue les scénarios de signature legacy standard et les scripts arbitraires : https://docs.trezor.io/trezor-firmware/common/bitcoin-signing.html . Ne pas demander à l'utilisateur d'acheter ou de solliciter des inconnus avant la fin du site. Ne pas promettre qu'un appareil DOGE classique fonctionne.

## Conditions nécessaires pour marquer D8 PASS sans fraude de preuve

Pour **H8.1** : transport et firmware étiquetés/provenance vérifiable, profile Regtest/clé+script exacts, aucune signature aveugle. **H8.2** : écran propre à l'appareil présentant **toutes** les conditions indépendamment de l'hôte. **H8.3** : vérification des refus des mutants **avant** tout calcul de signature par cet appareil, pas seulement ECDSA invalide après modification. **H8.4** : débranchements, expiration, reprise, rejeu. **H8.5** : rejets d'identités/version/script/réseau non épinglés. Preuves publiques signées, sans secrets. D8 requiert les cinq ensembles sur l'appareil approprié.

Le simple fait de signer correctement ne vaut **aucune** de ces preuves. La conclusion ne dépend ni d'une tolérance personnelle à la perte de fonds ni de la possession de 1,5 DOGE : on peut perdre des fonds réels sans améliorer D8.

## Conclusion et action permise

**Recommandation sans budget :** conserver le système financier sur Regtest et les branches brouillon. Les tests du cycle financement → expiration → remboursement + récupération privée sont désormais réussis et reproductibles, aucun nouveau matériel n'est requis pour les rejouer. Compléter le site et tous les autres essais logiciels ; puis obtenir un moyen de signer **physiquement** qui remplit chaque exigence avant de signer quoi que ce soit sur réseau public. Si aucun dispositif compatible ne peut être obtenu à 0 €, le statut de D8 matériel reste **BLOCKED** ; ne pas faire passer le signataire logiciel pour un appareil matériel. Conformément au propriétaire, **D9 audit indépendant attendra la fin du site**, et aucun tiers n'a été contacté pendant cette recherche.

Tous les dossiers d'essai ici sont des artefacts de laboratoire, non des instructions d'achat ou d'utilisation de fonds.
