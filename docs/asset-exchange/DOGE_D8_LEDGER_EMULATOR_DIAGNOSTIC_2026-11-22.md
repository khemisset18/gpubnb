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
