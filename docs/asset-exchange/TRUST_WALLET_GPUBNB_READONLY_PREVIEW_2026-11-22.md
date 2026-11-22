# GPUbnb / Trust Wallet / DOGE — preview strictement en lecture seule

Date : 22 novembre 2026. Portée : préparation de l'intégration utilisateur sans signer, financer ou diffuser.

## Fonctionnalité effectivement livrée

- Page \`apps/web/doge-wallet.html\` accessible par le lien de l'accueil GPUbnb.
- L'utilisateur peut copier **uniquement son adresse publique DOGE** depuis Trust Wallet et la faire contrôler **hors ligne** : Base58Check, double SHA256, version Dogecoin mainnet P2PKH (0x1e) ou P2SH (0x16).
- Résultat affiché par \`textContent\`, sans injection HTML, persistance ni appel API.
- Adresse **non vérifiée comme appartenant à l'utilisateur** ; aucune authentification Trust Wallet, aucun wallet connecté, aucune signature ou paiement. La zone échange est explicitement désactivée.
- Refus des adresses Bitcoin, des adresses DOGE testnet/Regtest, des entrées non Base58 ou à checksum faux, des phrases secrètes et des caractères anormaux.
- Aucun changement des clés, des contrats, du registre d'actifs, des routes settlement, des budgets RPC, des conditions de sécurité ou de la qualification DOGE existante.

Cette prévisualisation d'une adresse mainnet **n'utilise pas le Mainnet**, ne consulte aucune blockchain, ne rend pas le statut DOGE « tradable » et n'autorise aucune opération financière.

## Limites et étape suivante

L'interface Trust Wallet publiée ne démontre pas de fournisseur capable de signer les contrats DOGE Regtest P2SH-HTLC/CLTV de GPUbnb. Ses fournisseurs EVM/Bitcoin ne doivent pas être traités comme des signataires DOGE. Il ne faut pas confondre la vérification d'une adresse publique avec une liaison de portefeuille, une preuve de propriété ou une compatibilité d'échange.

Avant d'autoriser un véritable bouton « Échanger DOGE », il faudra une interface de signature DOGE documentée, la preuve indépendante des conditions affichées à l'utilisateur, les gardes anti-rejeu, les essais Regtest (signature / mutation / déconnexion), la qualification D2/D8, la revue indépendante D9 et une autorisation distincte pour toute production. Cette PR n'effectue aucune de ces opérations.

Tests locaux : \`node --test asset-exchange/web/test/trust-wallet-doge.test.mjs\` (6 PASS, Node 22). Les tests sont également inclus dans \`npm test\` sous \`asset-exchange\` et la CI Foundation.

Sources : [revue Trust Wallet existante](TRUST_WALLET_DOGE_REVIEW_2026-11-22.md), [documentation officielle TrustConnect](https://github.com/trustwallet/trust-connect-sdk), [Dogecoin Core](https://github.com/dogecoin/dogecoin/blob/master/src/chainparams.cpp).

**Statut final de cette livraison : PUBLIC_ADDRESS_PREVIEW_ONLY. DOGE D2/D8/D9 : BLOCKED.**
