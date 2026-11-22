# GPUbnb LTC — contrôles hors ligne (22 novembre 2026)

**Profil : LTC_BASECHAIN_TRANSPARENT_V1.** Extension additive à la spécification
existante docs/asset-exchange/LITECOIN_ADAPTER_SPEC_V1.md.

**Résultat local préalable : 39/39 méthodes Python PASS, zéro échec** dans
l'environnement de construction isolé. Les sous-tests négatifs sont inclus
dans les 39 méthodes. Ces contrôles ne prouvent ni la qualification Litecoin
Core, ni des scripts HTLC exécutables, ni un remboursement réel, ni la sécurité
de MWEB, ni les étapes L0–L9 complètes.

## Fichiers et périmètre

- offline_preflight.py : valide strictement une enveloppe publique fictive.
  Ne contient aucun appel réseau/RPC, nœud, clé, signature, wallet, construction
  de transaction, diffusion, minage ou capacité de règlement.
- test_offline_preflight.py : 39 tests, dont mutations de réseau,
  MWEB, montants, autorisations, séquence et sérialisation.
- fixtures/transparent_request_v1.json : montant public fictif de
  1.00000000 LTC, frais fictifs de 0.00100000 LTC et remboursement
  fictif de 0.99900000 LTC. Outpoint, script de destination et hauteur 450
  **non exécutables et non qualifiés**.

## Exécution dans Ubuntu WSL2 (depuis la racine du dépôt)

    unshare --user --map-root-user --net python3 -m unittest discover -s asset-exchange/qualification/litecoin -p 'test_*.py' -v

Pour lire l'état du seul exemple public :

    unshare --user --map-root-user --net python3 asset-exchange/qualification/litecoin/offline_preflight.py

Aucune installation, aucun vrai LTC, aucune phrase secrète, aucun portefeuille,
aucune transaction Mainnet et aucune signature n'est nécessaire.

## Protections et limites

Le précontrôle refuse les champs JSON inconnus ou dupliqués, les autres
réseaux ou cryptos, les déclarations MWEB, les autorisations de signer,
financer ou diffuser, les montants mal formés et les incohérences de frais,
les variantes du sighash et de la séquence, et les faux champs de qualification.

Même accepté, le rapport fixe toujours : qualified=false, canSign=false,
canBroadcast=false, nativeConsensusVerified=false,
networkIdentityVerified=false, sourceAuthenticityVerified=false,
hardwareQualified=false, automaticSettlementSupported=false.

**Un JSON falsifié mais cohérent peut passer** : ce contrôle ne vérifie pas
son origine, ne prouve pas les règles de consensus et ne donne aucune
autorisation financière.

## Reste à qualifier selon la spécification existante

| Gate | État |
| --- | --- |
| L0 — Intégrité Litecoin Core 0.21.5.8 et provenance | NON QUALIFIÉ |
| L1 — Réseau/genesis exact en regtest privé | NON QUALIFIÉ |
| L2 — Refus MWEB par le logiciel de protocole et le nœud | Contrôles d'enveloppe seuls PASS |
| L3 — Script/witness/CLTV/CSV/sighash natifs | NON QUALIFIÉ |
| L4 — Lock, claim, remboursement et refus natifs | NON QUALIFIÉ |
| L5 — Frais, dust, RBF et pinning Litecoin | NON QUALIFIÉ |
| L6 — Récupération indépendante avant lock | NON QUALIFIÉ |
| L7 — Réorganisations et watchers indépendants | NON QUALIFIÉ |
| L8 — Signataire matériel | DIFFÉRÉ / BLOQUÉ |
| L9 — Audit et activation | DIFFÉRÉ / BLOQUÉ |

Le statut LTC reste MARKETPLACE_ONLY, automaticSettlementSupported=false,
et la route financière reste absente. Aucun code DOGE, registre de capacités,
runtime financier ou workflow n'est modifié par cette branche.

La spécification actuelle identifie Litecoin Core v0.21.5.8 et une empreinte
candidate du binaire Linux. Aucune signature de distribution, archive téléchargée,
source officielle intégrale ou identité de nœud n'a été vérifiée par ce travail.
Ne pas utiliser le candidat documentaire comme preuve L0.

Source amont : https://github.com/litecoin-project/litecoin/releases/tag/v0.21.5.8.

## L2 — contrôle complémentaire des chaînes d'adresses publiques

`transparent_address_guard.py` ajoute une classification pure de
chaînes Bech32 transparentes **regtest v0 uniquement** (HRP `rltc`,
checksum BIP173, P2WPKH et P2WSH). `test_transparent_address_guard.py`
contient **22 méthodes supplémentaires**, testées avec succès dans
l'environnement local de construction. Avec les 39 tests antérieurs,
**61 tests sont attendus après actualisation dans WSL2**, et ne doivent
pas être revendiqués comme vérifiés sur WSL2 avant exécution.

Ce contrôle **ne s'intègre à aucun runtime financier** ; il n'accepte
aucune autre chaîne et refuse également les préfixes MWEB (`tmweb`)
et les adresses Mainnet/testnet. Il ne lit ni wallet ni transaction,
et ne prouve pas l'exclusion MWEB des données réellement relayées,
des peg-ins/outs, du change ou de la récupération. Les indicateurs
financiers et de qualification restent toujours `false`.

Pour exécuter les deux suites (sans clé, réseau ou signature) depuis
la racine du worktree :

    PYTHONDONTWRITEBYTECODE=1 unshare --user --map-root-user --net python3 -m unittest discover -s asset-exchange/qualification/litecoin -p 'test_*.py' -v

Aucun changement au registre, au nœud, au signer, au workflow ou
à la branche DOGE.

## L3 — script HTLC candidat en octets publics, sans opération blockchain

`candidate_htlc.py` propose **uniquement un format d'octets de
script P2WSH fictif** pour examen : branche de preimage SHA-256
32 octets et clé redeem, branche de hauteur CLTV + clé refund.
Les données publiques de démonstration ne sont pas garanties comme
des points valides et ne représentent aucun portefeuille.

`test_candidate_htlc.py` ajoute **26 tests unitaires** (encodage
ScriptNum minimal et bornes, calcul SHA-256 du script, structure
IF/ELSE/ENDIF, mutations et refus). Ils ont été exécutés avec
succès dans l'environnement local de construction ; le worktree
WSL2 de l'opérateur n'a **pas encore** été retesté depuis cet ajout.

Le total à confirmer sur le PC est maintenant **87 méthodes (61+26)** :

    PYTHONDONTWRITEBYTECODE=1 unshare --user --map-root-user --net python3 -m unittest discover -s asset-exchange/qualification/litecoin -p 'test_*.py' -v

Ce module **ne génère pas de transactions, ne signe rien, ne fait
aucun appel réseau ni RPC et ne prouve aucune standardness ou consensus
natif**. L'exécution et la validité d'un refund Litecoin restent
bloquées jusqu'aux essais natifs. Ne pas intégrer au runtime financier.
