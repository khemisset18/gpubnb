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

**Défaut réellement reproduit et corrigé dans le scénario de test** : les premières
tentatives de signature fictive P2PKH du Ledger émulé (PR #388,
commit \`7924a889\`) faisaient sortir Speculos avec code 255. Le script
d'émission d'APDU séparait le numéro de séquence 4 octets du script d'entrée,
alors que le parseur officiel exige ces octets dans le **même APDU**.
Le correctif sur le commit \`8a94d60936109c78b6bca1ce0eeb12ccf82d8d16\`
les transmet ensemble avec un test de non-régression. [Exécution expérimentale réelle](https://github.com/khemisset18/gpubnb/actions/runs/45058707523) :
**SUCCESS**, ECDSA secp256k1 vérifiée sur une transaction DOGE **synthétique
P2PKH**, mutation d'une sortie de 1 koinu refusée par le vérificateur,
affichage émulé du montant, de l'adresse et des frais.
La déclaration initiale d'échec reste conservée dans les anciens logs.

**Limite conservée** : l'application Ledger examinée se déclare Dogecoin
mainnet classique ; la signature réelle **DOGE Regtest legacy P2SH-HTLC/CLTV**
n'est ni demandée ni vérifiée. La confirmation d'écran est automatisée sur
un écran **simulé**, non sur un appareil réel. D8 complet reste **BLOCKED**.

Même si la campagne est entièrement verte :
D8 matériel reste **BLOCKED**, D9 audit indépendant **NON RÉALISÉ**,
activation Mainnet et transactions financières **INTERDITES**.
Ce workflow ne fusionne rien dans main/dev.
