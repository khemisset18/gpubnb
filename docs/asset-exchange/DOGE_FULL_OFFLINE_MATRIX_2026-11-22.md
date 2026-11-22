# DOGE — régression logicielle complète, isolée, sans frais (22 novembre 2026)

**Cible** : campagne de tests unitaires et de sécurité disponible sur la révision
exacte du code, sans mélanger les preuves natives des anciens commits.

Le workflow crée un nouveau namespace Linux, **loopback uniquement**. Aucun
nœud Dogecoin, WalletConnect, Trust Wallet, réseau public, compte réel,
diffusion on-chain ou dépenses DOGE. Tous les tests Node Asset Exchange et
les groupes de tests Python D0/D1/D2/D6/policy/D8/wallet-agent/recovery sont
exécutés. Un rapport JSON public enregistre les compteurs, échecs et SHA256
des logs non publiés. La sortie échoue si une suite échoue ou si le
compteur de tests attendu est absent.

Un bilan vert est un PASS de **ces tests logiciels uniquement** : aucun succès
des scénarios Dogecoin natifs, de l'écran matériel D8 ni de la qualification
Trust Wallet HTLC n'est déduit de cette campagne.

**Défaut non masqué** : l'essai de signature fictive P2PKH du Ledger émulé sur
PR #388 a échoué : Speculos termine avec exit 255 lors des APDU de
préparation. Les vérifications unitaires du verificateur de signatures
ne constituent pas une signature Ledger effective. La compatibilité exacte
DOGE Regtest P2SH-HTLC/CLTV GPUbnb n'est pas prouvée.

Même si la campagne est entièrement verte :
D8 matériel reste **BLOCKED**, D9 audit indépendant **NON RÉALISÉ**,
activation Mainnet et transactions financières **INTERDITES**.
Ce workflow ne fusionne rien dans main/dev.
