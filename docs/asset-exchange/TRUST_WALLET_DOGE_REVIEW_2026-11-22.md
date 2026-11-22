# Trust Wallet — dernières versions et qualification DOGE, 22 novembre 2026

**Décision : compatibilité avec notre profil DOGE complet BLOCKED.**
La recherche utilise désormais les dernières versions officielles publiées,
comme demandé. Aucune version installée, clé, seed ou action sur le portefeuille
personnel n'est nécessaire pour cette recherche publique.

Ce dossier complète le [candidat interne](DOGE_EXTERNAL_SIGNER_INTERNAL_2026-11-22.md).
Le code qualifié reste `68ca4f72db340053d0208424ddba0235a57052d1` ; la tête
documentaire de référence est `d349a4cedee0b6ccf183d563e42aaab0c9965503`.
La présente étude ne modifie aucun code financier, runtime, lock, scanner,
budget RPC ou garde Regtest et ne répète aucun scénario natif DOGE.

## Versions publiées identifiées

| Cible demandée | Version officielle observée | Source et portée |
| --- | --- | --- |
| Windows / Chrome / Trust Wallet | **26.45.1**, publication du 5 novembre | [Chrome Web Store](https://chromewebstore.google.com/detail/trust-wallet/egjidjbpglichdcondbcbdnbeeppgdph?hl=en) ; version confirmée dans le paquet signé téléchargé directement chez Google |
| Android / Trust Wallet | **26.46.9**, page mise à jour le 14 novembre | [Google Play](https://play.google.com/store/apps/details?id=com.wallet.crypto.trustapp&hl=en&gl=FR), champ structuré courant `ds:5 → [1,2,140,0,0,0]`, distingué des versions mentionnées dans les avis |
| iOS / Trust Wallet | **26.46.9**, publication du 14 novembre | [App Store France](https://apps.apple.com/fr/app/trust-wallet-bitcoin-crypto/id1288339409) et [API Apple](https://itunes.apple.com/lookup?id=1288339409&country=fr) |

Ce sont des versions publiées observées, pas une preuve d'installation sur les
appareils du propriétaire. Aucun ancien numéro provenant d'un extrait de moteur
de recherche n'est présenté comme le numéro courant. Les rollouts et régions
peuvent faire évoluer ces résultats ; une nouvelle version appelle une nouvelle
revue de ses octets et de ses interfaces.

## Paquet Chrome réellement examiné

Le CRX provient du service officiel de mise à jour Google, pour l'identifiant
`egjidjbpglichdcondbcbdnbeeppgdph` confirmé par le
[site Trust Wallet](https://trustwallet.com/browser-extension).
L'archive a été téléchargée, sans installation ni exécution de son JavaScript.

| Mesure | Résultat observé |
| --- | --- |
| CRX | 14 882 111 octets, version 26.45.1 |
| SHA256 CRX | `798e41ee33fa382ebb23ae7b9e33943bc71267d873cd9230360456d95d786391` |
| SHA256 ZIP interne | `e31544bab0295d2b59b25cbb299f7c8fdf210717c893a6823c606602de2c82f9` |
| Authentification CRX3 | Deux preuves RSA/SHA256 et une preuve ECDSA/SHA256 vérifiées sur le contenu signé complet ; l'une des clés RSA dérive exactement l'identifiant attendu |
| Empreinte de cette clé publique | `4698391f6b82732ed31213d144ff63f7b225169b1bf752eeb296149894b7b9c7` |
| Intégrité ZIP | 434 entrées, CRC valides, tailles et chemins bornés |
| Contrôles négatifs du vérificateur | 3 refus attendus : contenu signé modifié, autre identifiant d'extension et Python optimisé ; aucune fausse preuve de succès écrite |

Ce PASS authentifie l'archive examinée. Il ne constitue ni un audit de Trust
Wallet ni un test interactif de ses transactions. Le binaire tiers complet
n'est pas ajouté au dépôt ; ses empreintes et le vérificateur sont conservés.

## Blocage précis trouvé dans cette version

Dans le bundle signé `inpage.js`, l'enregistrement des fournisseurs dApp déclare
exactement **ethereum, solana, binance, tron, bitcoin**. Aucun fournisseur DOGE
n'est enregistré dans cette séquence. La route générique rejette un réseau
sans fournisseur avec le code 4200. La partie Wallet Standard UTXO annonce
`bitcoin:mainnet` et ses méthodes de signature sont des méthodes Bitcoin.

Il s'agit d'une revue statique des octets publiés. Aucune demande de connexion,
de compte, de signature ou de diffusion n'a été envoyée à une extension.
Le résultat ne prétend pas sonder tous les comportements internes de l'app.

Le SDK TrustConnect officiel a également été examiné à la révision
[`70f84de35dceaae36efe3a7602d81111c4f2a748`](https://github.com/trustwallet/trust-connect-sdk/commit/70f84de35dceaae36efe3a7602d81111c4f2a748).
Ses [types de réseaux BIP122](https://github.com/trustwallet/trust-connect-sdk/blob/70f84de35dceaae36efe3a7602d81111c4f2a748/packages/types/namespaces/bip122/src/chain.ts)
déclarent Bitcoin mainnet, testnet et regtest. Le Regtest fourni est identifié
par `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`.
Notre Regtest Dogecoin est identifié par
`3d2160a3b5dc4a9d62e7e66a295f70313ac808440ef7400d6c0772171ce973a5`.
Ces réseaux sont distincts. Remplacer un nom de chaîne ou utiliser une API
Bitcoin ne démontrerait pas la signature DOGE attendue et sa revue à l'écran.

Les documents de deep linking consultés décrivent les paiements et la connexion
WalletConnect. Ils n'apportent pas de preuve pour notre signature DOGE Regtest
legacy P2SH-HTLC/CLTV, avec script, lock, sequence et termes complets vérifiables.
Les anciennes URL des dépôts TrustSDK Android/iOS et du dépôt de documentation
ont retourné 404 lors de la lecture directe : leurs résultats indexés historiques
ne sont pas promus en preuve du fonctionnement des versions actuelles.

Wallet Core possède une définition DOGE. Ce composant de développement et une
application Trust Wallet installée constituent des objets différents à tester :
la présence d'une primitive cryptographique dans la bibliothèque ne prouve pas
qu'une interface correspondante soit exposée et approuvée dans l'application.
Aucun résultat sur les apps Android/iOS réellement exécutées n'est revendiqué.

## Conséquences pour la qualification

| Condition | État et action nécessaire |
| --- | --- |
| Envoi/réception DOGE ordinaires dans Trust Wallet | Fonction annoncée par le fournisseur ; aucun transfert réel effectué dans cette mission |
| Fournisseur DOGE du bridge Chrome 26.45.1 étudié | Non déclaré dans le bundle signé ; aucune intégration de signature DOGE complète qualifiée |
| Signature DOGE Regtest avancée dans les apps mobiles courantes | **NON DÉMONTRÉE** ; ni un QR WalletConnect ni les métadonnées du store ne remplacent l'essai |
| Signataire logiciel GPUbnb déjà testé | Preuves existantes conservées, dont 60 tests wallet, 40 recovery et le contrôle natif de 3 remboursements / 3 mutations ; son périmètre POSIX et ses limites restent ceux du bilan précédent |
| D2 — gel du profil | **BLOCKED** tant que les compatibilités exigées par la spécification ne sont pas établies |
| D8 — matériel / affichage / déconnexion | **NON TESTÉ** ; les versions logicielles PC/mobile ne satisfont pas à elles seules le critère matériel existant |
| Audit indépendant | **NON RÉALISÉ, hors mission** ; aucun travail interne n'est suspendu pour attendre un auditeur |

La suite techniquement justifiée est de disposer d'un chemin de signature
exposant explicitement le réseau DOGE Regtest et le profil exact, puis de
vérifier les termes affichés, les octets retournés, les mutations, les refus,
les déconnexions et la reprise avec des clés de test jetables. Si cette capacité
n'est pas fournie par Trust Wallet, elle requiert une évolution de son interface
ou un autre signataire compatible ; une correction côté GPUbnb ne peut pas
être présentée comme une preuve d'une fonction absente de l'interface étudiée.
Un éventuel matériel sera choisi après vérification de ce profil exact.

**DOGE — VALIDATION TECHNIQUE INTERNE COMPLÈTE : BLOCKED.** Aucun critère n'est
retiré pour transformer cet état en PASS. Aucun fonds réel, Mainnet, clé
utilisateur, déploiement financier ou merge main/dev n'a été utilisé.

## Preuves et reproduction

Les [reçus](research/2026-11-22/trustwallet-current/),
le [résultat de compatibilité](research/2026-11-22/trustwallet-current/compatibility-result.json)
et les [empreintes](research/2026-11-22/trustwallet-current/SHA256SUMS)
conservent les versions, sources, tailles, identités et limites réelles.
Le [vérificateur CRX](research/2026-11-22/trustwallet-current/inspect_official_crx.py)
ne lance aucun code de l'extension.

Pour reproduire sa vérification, copier ce script dans un répertoire temporaire
hors du checkout, y placer le CRX obtenu auprès du service officiel Google sous
le nom `trust-wallet-official.crx`, puis exécuter `python3 -I inspect_official_crx.py`
avec le module `cryptography` disponible. Comparer version, SHA256 et identifiant
au présent reçu. Si les octets diffèrent, il s'agit d'une nouvelle cible à
examiner, pas de la répétition attribuable à cette preuve. Ne pas installer
l'extension pour cette seule vérification de source.
