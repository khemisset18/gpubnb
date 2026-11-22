# GPUbnb DOGE — D8 : passage de relais à la qualification physique

**État au 22 novembre 2026 : le précontrôle logiciel est distinct de D8 physique.** Les transactions et signatures Ledger testées sont synthétiques, produites dans Speculos. Aucun réseau DOGE, aucune vraie clé, aucun financement, aucune dépense, aucun broadcast. D8 physique et D9 sont **BLOCKED / NOT_TESTED**.

## Ce qui est démontré

- [PR expérimentale #388](https://github.com/khemisset18/gpubnb/pull/388) : application Ledger Legacy DOGE compilée, écran émulé, adresse publique vérifiée, signature P2PKH fictive et digest de remboursement de structure D2 P2SH-HTLC/CLTV signés par l'émulateur, vérification ECDSA indépendante.
- [Preuve initiale HTLC](https://github.com/khemisset18/gpubnb/actions/runs/45059081817) : script synthétique de hauteur CLTV 1351, séquence 4294967294, montant et frais fictifs. Les mutations appliquées **après** signature rendent le digest/signature incompatibles, ce qui ne démontre PAS un refus du dispositif **avant** signature.
- [Écran de contrôle observé](https://github.com/khemisset18/gpubnb/actions/runs/45059319385) : adresse de destination exacte, montant et frais ; pas de réseau Regtest, rôle refund, hauteur CLTV, séquence, référence du financement, redeemScript.
- Le contrôle `asset-exchange/qualification/dogecoin/d8/d8_prephysical_gate.py` lit les 4 rapports du même run, refuse les preuves manquantes ou falsifiées, et publie uniquement `EMULATOR_DIAGNOSTIC_PASS_HARDWARE_BLOCKED`. Il ne peut **jamais** valider matériellement D8.

## Conditions préalables à D8

1. Geler le profil signer exact **Dogecoin Regtest legacy P2SH-HTLC/CLTV**, le genesis, le type de signature et l'origine des termes. Le firmware Ledger Legacy étudié s'identifie **DOGE mainnet** : ce profil n'a pas été qualifié sur appareil.
2. Utiliser **uniquement un portefeuille physique compatible effectivement démontré** avec une nouvelle seed jetable sans fonds réels, à l'intérieur du laboratoire privé autorisé. Ne rien acheter sur la seule foi du support DOGE classique.
3. Identifier et vérifier la provenance du modèle, firmware signé, version/hash d'adaptateur, clé publique de test, digest de requête et digest de termes déjà conservés indépendamment. Aucune seed ni clé privée ne doit sortir de l'appareil.
4. Mettre en place une revue **sur l'appareil lui-même** de tous les champs `signer_review_fields`, pas uniquement dans l'ordinateur hôte. L'appareil testé n'affiche pas actuellement ces informations.

## H8.1–H8.5 à exécuter physiquement (non exécutés)

| Cas | Contrôle obligatoire | Échec bloquant |
| --- | --- | --- |
| H8.1 | Liaison adaptateur/appareil, provenance firmware, profil/regtest P2SH/CLTV explicite, pas de blind signing | Profil ou script unsupported ; ce refus sûr ne qualifie pas l'appareil |
| H8.2 | Opérateur compare toutes les conditions sur **écran physique** : réseau/genesis, rôle refund, outpoint, destination/script, valeur, frais des paliers, lock/CLTV, sequence et digest | Un seul champ omis ou invérifiable |
| H8.3 | Mutations **avant signature** séparées de destination, valeur, frais, lock, sequence, sighash, outpoint et réseau ; journaliser chaque refus avec reçu d'origine indépendant | Une signature acceptée malgré mutant |
| H8.4 | Déconnecter avant affichage, durant approbation, puis avant livraison de réponse ; reconnecter, refuser vieux rejouages et expiration | Signature de repli, diffusion, réponse incohérente |
| H8.5 | Changer indépendamment version/profil/firmware, essayer réseau et scripts non reconnus | Acceptation ou repli non déclaré |

**Preuves minimales** : commit+hash du candidat, firmware/adapter épinglés, provenance, hash du numéro de série (pas numéro brut), demande et termes publics originaux et mutés, journal d'écran physique cadré sans données personnelles, horodatages, reçu de consentement, signature/erreur ou refus, reprise/replay. **Ne jamais publier ni communiquer seed, clés privées, fonds ou données personnelles.**

## Décision

On peut continuer gratuitement le développement et les essais dans Regtest privé. Mais **sans appareil physique compatible et consentement sur son écran, D8 ne peut pas être conclu**, même avec 100 % des tests d'émulation au vert. Aucun merge ni activation de swaps DOGE réels n'est autorisé. D9 sera la revue indépendante globale après la fin du site, selon le souhait du propriétaire.
