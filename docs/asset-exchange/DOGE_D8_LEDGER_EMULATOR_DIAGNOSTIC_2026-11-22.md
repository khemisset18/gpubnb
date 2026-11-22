# DOGE D8 — essai gratuit d'émulateur Ledger (22 novembre 2026)

**But : exécuter un VRAI programme de wallet Ledger Dogecoin dans Speculos, sans achat, sans DOGE réels, et sans faire passer une simulation pour D8 physique.**

## Exécution

Le workflow \`.github/workflows/asset-exchange-dogecoin-ledger-emulator.yml\` se lance dans une pull request isolée.
Il télécharge \`LedgerHQ/app-bitcoin-legacy\` à la révision exacte
\`79f3036daec38347747fb498470bed3cfb103440\` et ses submodules, vérifie les
paramètres DOGE mainnet du Makefile, puis essaie de construire \`COIN=dogecoin\`
avec la chaîne de compilation officielle Ledger pour Nano S+. Si la compilation
réussit, il démarre l'app ELF dans le conteneur officiel Speculos sur réseau
**désactivé** et capture seulement l'écran d'accueil émulé et les SHA de l'ELF.

Aucune application client n'est connectée au wallet, aucune transaction n'est
construite, financée, signée, minée ni diffusée. Il n'y a pas de nœud Dogecoin,
de RPC, d'adresse utilisateur ou de seed personnelle. Les images Docker officielles
sont actuellement des tags \`latest\` : leurs digests sont imprimés, mais cette
première expérience n'est pas un run qualifié avec toutes les dépendances épinglées.

## Interpréter les résultats sans tromperie

- **Build FAIL** : problème d'outillage/compatibilité à résoudre avant toute simulation.
- **Speculos boot PASS** : l'ELF DOGE fonctionne sous simulation ; pas de preuve
  de signature de transaction, de CLTV, de réseau DOGE Regtest, de confirmation
  d'utilisateur, ni d'écran physique.
- **Qualification D8** : reste \`BLOCKED\` même si l'émulateur démarre, car le
  profil DOGE Regtest legacy P2SH-HTLC/CLTV et l'intégralité de l'affichage
  \`signer_review_fields\` sont à démontrer. Les contrôles H8.1–H8.5 de l'appareil
  réel restent manquants.
- Une application Dogecoin standard utilise des paramètres mainnet (préfixes
  d'adresse 30/22), qui ne démontrent pas le Regtest privé de GPUbnb.
- Pour continuer après cet essai : expérimenter une requête de signature
  **strictement synthétique et privée**, conserver l'original et ses mutations,
  comparer les octets et écrans, **sans activer** DOGE dans l'Asset Exchange.

La PR 376 et son candidat logiciel restent inchangés ; ne pas merger \`main/dev\`,
ne pas modifier le profil D2 ni les garde-fous, ne pas utiliser Trust Wallet
ou les 1,5 DOGE du propriétaire. L'audit indépendant D9 sera entrepris à la fin
du site selon la décision du propriétaire.

Références : https://speculos.ledger.com/user/getting_an_app.html
et https://speculos.ledger.com/user/api.html .


## Extension expérimentale — commandes APDU publiques, aucun échange

Une fois Speculos démarré, le test \`ledger_emulator_probe.py\` envoie
exactement **cinq** APDU autorisées et bornées vers le processus émulé :
version de la monnaie, version de l'application, clé/adresse **publique**
BIP44 DOGE \`m/44'/3'/0'/0/0\` **sans affichage ni approbation**, puis deux
commandes négatives (classe et instruction inconnues). Il vérifie la réponse
DOGE des préfixes **30/22**, le checksum Base58Check et la correspondance
de l'adresse avec la clé publique fournie. Les seules données conservées pour
l'adresse/la clé sont leurs SHA256.

**Ce test ne demande AUCUNE signature, n'envoie aucun APDU de transaction,
n'utilise aucun DOGE, ne démontre pas la possession de clés utilisateur, ne
connecte pas Trust Wallet, ne teste pas le Regtest ni les contrats HTLC/CLTV.**
L'émulateur utilise sa seed de test par défaut. Un échec est consigné sans
activation ni contournement. La qualification D8 demeure **BLOCKED**.

Les tests unitaires du parseur peuvent être lancés sans émulateur :
\`python3 -m unittest discover -s asset-exchange/qualification/dogecoin/d8 -p 'test_ledger_emulator_probe.py' -v\`.


## Étape suivante : tentative de signature synthétique

Un scénario distinct construit un faux UTXO DOGE de **5 DOGE fictifs** (octets locaux, non publiés) et un paiement P2PKH de **4,99 DOGE fictifs**, avec **0,01 DOGE fictif de frais**. Il demande l'approbation à l'écran émulé uniquement après la lecture des montants et de l'étiquette d'adresse, puis vérifie une éventuelle signature ECDSA secp256k1 et le rejet cryptographique d'une transaction dont la sortie a été mutée de 1 koinu. Les réponses de refus/échec sont conservées comme diagnostics, sans signature de repli.

Le test ne prouve pas l'affichage complet et indépendant de tous les champs ; une approbation simulée n'est jamais assimilée à un opérateur humain. Aucun serveur Dogecoin, UTXO réel, RPC, transaction diffusée, clé utilisateur, Trust Wallet ni réseau externe. Si le pilote legacy DOGE ne permet pas cette séquence, **l'échec est réel et D8 reste BLOCKED**, pas artificiellement promu PASS. Une signature P2PKH classique ne prouverait pas l'HTLC/CLTV Regtest exigé par GPUbnb.


## Essai supplémentaire : remboursements HTLC/CLTV synthétiques

Un nouveau scénario dans le *même* émulateur Ledger Dogecoin teste
la structure D2 de GPUbnb (template HTLC \`6382012088a8...\`,
branche REFUND, P2SH, lock CLTV 1351, séquence nonfinale
\`0xfffffffe\`), mais remplace la clé publique de remboursement par la
clé jetable **publique** obtenue de l'émulateur. Aucun seed n'est extrait.
Financement fictif 5 DOGE, sortie fictive 4,99 DOGE, frais fictifs 0,01 DOGE.
Il tente de signer un condensat legacy SIGHASH_ALL, vérifie publiquement
ECDSA et refuse les mutations de montant, lock et redeemScript.

**Ne pas confondre** signature numérique du hash de transaction en
configuration DOGE mainnet avec une signature indépendante
de l'ensemble des conditions Regtest/HTLC. Le firmware étudié n'affiche pas
indépendamment tous les champs \`signer_review_fields\` de GPUbnb
(réseau/genesis, rôle refund, outpoint, CLTV/lock, sequence, sighash etc.).
Même si ECDSA et les mutations passent, le résultat **ne valide PAS D8**.
Il ne fait aucune dépense, ne diffuse rien, ne communique avec aucun nœud
ou service et conserve les preuves comme diagnostic isolé en PR brouillon.
