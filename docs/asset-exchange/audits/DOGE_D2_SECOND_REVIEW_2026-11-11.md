# Revue technique D2 DOGE — 11 novembre 2026

**Décision globale : D2 BLOCKED. Les observations de la matrice sont recevables dans leurs périmètres déclarés ; elles ne suffisent pas à qualifier une route financière.** Aucun défaut de consensus du candidat P2SH/CLTV/SIGHASH_ALL examiné n'a été trouvé dans cette revue. Deux défauts de harnais/documentation et une limite importante du diagnostic à mempool local sont détaillés ci-dessous.

Cette revue est réalisée par un agent interne distinct de celui qui a implémenté les changements. Elle constitue une seconde lecture technique, pas un audit humain externe indépendant et pas une certification D9. Aucun nœud, bibliothèque Dogecoin native, minage, signature de nouvelle transaction ni diffusion n'a été exécuté pour cette revue. Les validations cryptographiques mentionnées sont des vérifications hors ligne des octets déjà présents dans les preuves.

## Versions réellement examinées

Les métadonnées GitHub des quatre PR ont été relues :

| PR | Branche et tête distante | Rôle |
| --- | --- | --- |
| [344](https://github.com/khemisset18/gpubnb/pull/344) | asset-exchange/doge-native-spends-20261107 ; a008a3ac6a0f0232d826f6b5b559a1eee370399e | Transactions signées natives initiales |
| [349](https://github.com/khemisset18/gpubnb/pull/349) | asset-exchange/doge-refund-hardening-20261109 ; f048e696a8c3d5ebdb90458c131451b959940592 | Persistance du refund avant financement |
| [350](https://github.com/khemisset18/gpubnb/pull/350) | asset-exchange/doge-script-boundaries-20261110 ; 80165138b0c706f70d45eab1258180e449652e9a | Limites de scripts et retransmission identique |
| [351](https://github.com/khemisset18/gpubnb/pull/351) | asset-exchange/doge-refund-fees-20261111 ; 268936e87d56cd4fa18b35ec85c1ee094bddc6c0 | Reconstruction sous plafond après hausse du minimum de mempool |

Snapshot local de départ : 724ca3d4303981097fba60b6427d932fbf918c88. Les blobs essentiels ont été comparés à leur contenu distant avec ref explicite : native_spends.py (PR350) 0a7f8d89718a066b2c22a3848a438bba0baa64e4 ; gpubnb_policy_tests.cpp (PR351) 8d7c2b2ee8b7b23d2d0f8dc2781f50ecb20954fd ; catalogue native_scenarios_v1.json 7b9653473b13ca466211d8f5ac915d224a1d60d4. Ils correspondent au snapshot local examiné. Les modifications ultérieures de l'implémentation doivent être examinées séparément.

Source consensus : dogecoin/dogecoin e0a1c157791544e818c901bd9341896965afbf9d, version 1.14.9. Archive D0 : 4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8. Bibliothèque consensus : 3c27dd2f3018a3bd659648129a94ba5f211e84b8ec6d308f7f0db001b5e7902b. La source locale de référence est épinglée à ce commit.

## Vérifications indépendantes réalisées

1. Lecture de la mission jointe, des builders/codecs/signers, du harnais natif, des diagnostics C++, des gardes Python, des workflows actuels, des plans D2 et de la spécification d'adaptateur.
2. Recalcul des SHA256 des cinq archives ci-dessous et vérification de chaque fichier listé dans leur index interne SHA256SUMS.
3. Analyse séparée des 32 transactions sérialisées de la dernière expérience D0 : lecture des CompactSize, entrée, scriptSig, séquence, sorties et locktime sans importer le sérialiseur du harnais. Tous les TXID recalculés correspondent aux rapports.
4. Reconstruction séparée de SIGHASH_ALL legacy et vérification ECDSA secp256k1 avec Cryptography 50.0.2. Les 23 signatures mathématiquement valides et les 9 signatures/encodages volontairement invalides correspondent aux contrôles attendus. En particulier, les signatures des scripts CLTV négatif, CLTV six octets et 16 sigops sont valides : leur rejet n'est pas expliqué par une mauvaise signature. Les mauvais secrets, les contrôles de politique et les UTXO absents/immatures utilisent également des signatures valides.
5. Recalcul du montant d'entrée de financement depuis sa réponse RPC historique et de la somme des sorties : frais de financement exactement 100 000 000 koinu ; sept sorties de test de 10 000 000 000 koinu chacune. Les montants des remboursements et les sorties observées correspondent aux fixtures.
6. Vérification des identités : regtest, genesis 3d2160a3b5dc4a9d62e7e66a295f70313ac808440ef7400d6c0772171ce973a5, version réseau 1140900, BIP65 actif observé à hauteur 1352 ; namespaces avant/après avec seule interface lo et aucun pair ; acceptnonstdtxn=0, aucun flag promiscuous, wallet désactivé.
7. Relecture des états GitHub : run natif 42875442068, étape d'exécution réussie, gate complet D2 échoué comme prévu ; run source 43005573333 réussi avec distinction explicite SOURCE_DIAGNOSTIC_NOT_D0.
8. Nouvelle exécution de 58 tests strictement hors ligne : test_spend_preparation, test_htlc_codec, test_offline_candidate, test_native_result_contract et test_qualification_request. **58 PASS**, aucun exécuteur Dogecoin chargé.

| Archive locale | SHA256 vérifié | Portée |
| --- | --- | --- |
| doge-native-fifth.zip | 94f6afeae4ffbd7e5087e5758ca8a0de9067c6beed7c1168f4393d5343a6326d | 21 cas, run 42512160122 ; expérience PASS, qualification BLOCKED |
| doge-refund-hardening.zip | 8a6efb39a9eb6e129045e256c5a1d8e155250823b0b50aa1df15056d7d7d571a | 29 cas, run 42674622556 |
| doge-script-boundaries.zip | 0692b3e7957a43126b2d7841bd3252d977b56278b3f663cab219f7b38ad230fc | 32 cas, run 42863850857 |
| doge-refund-retry.zip | f1db67f4f70cb1e409922bbabb6b58fb3749a3dfabbde9c5b66f1495cfe335e8 | 32 cas, 69 RPC, 1356 blocs, run 42875442068 |
| doge-refund-fees.zip | 3a556f5dc86084184234c6e2c3b315834d7a21f27b61995686137b4818a6c8ea | 3 cas source / 60 assertions, run 43005573333 |

Les trois premiers essais natifs échoués restent conservés : mauvaise attente Missing inputs à la place de bad-txns-inputs-spent ; perte du tip au redémarrage ; reindex lancé après un redémarrage ayant altéré l'état. Leur présence et leur statut FAIL n'ont pas été masqués. Le quatrième essai est PASS pour son périmètre de 16 cas.

## Constats actionnables

### R1 — P2, défaut de harnais : le plafond de fixtures bloque une retransmission connue

Baseline native_spends.py:231–235 : submit exige `len(submitted) < 32` avant d'ajouter les octets à un ensemble. À 32 transactions uniques, la retransmission d'une des transactions déjà connues échoue, même si elle n'ajoute aucune fixture. Cela contredit le plafond annoncé de 32 fixtures uniques et la propriété de retransmission idempotente.

Correctif demandé : autoriser un hex déjà présent ; appliquer la limite uniquement à un nouvel hex. Ajouter une régression où 32 fixtures connues permettent de renvoyer la première et refusent une 33e différente. **Le propriétaire de l'implémentation a accusé réception et annoncé ce correctif ; il n'est pas validé par le présent snapshot.** Les essais conservés utilisent moins de 32 transactions uniques, donc ce défaut n'invalide pas leurs résultats.

### R2 — P3, justification d'état périmée

Baseline native_spends.py:46–49 : les blockers affirment que la matrice complète et les instruments de poussière/minimum dynamique sont absents, alors que des preuves séparées existent désormais. Leur absence dans l'unique exécuteur D0 ne doit pas être présentée comme absence dans tout le chantier.

Correctif demandé : qualifier ces phrases par le périmètre de ce run et référencer la décision consolidée. Ne pas supprimer la gate BLOCKED ni transformer les diagnostics source en preuves D0. Correction annoncée par le propriétaire ; à réexaminer sur son nouveau commit.

### R3 — P2 pour les extensions futures, limite du pool local du diagnostic source

PR351, gpubnb_policy_tests.cpp:108–109 crée un CTxMemPool local et le transmet à AcceptToMemoryPool. Or dans le commit Dogecoin épinglé, validation.cpp:404–445, CheckSequenceLocks vérifie le verrou et construit sa vue à partir du **mempool global**, pas du pool passé à AcceptToMemoryPool ; l'appel est effectué à validation.cpp:738–741.

Les dépenses actuelles sont version1 et leurs parents sont confirmés ; cette divergence ne change pas la preuve conservée. Mais il serait incorrect de réutiliser ce montage comme preuve générale d'ancêtres non confirmés, de CSV, de pinning ou de remplacement. Une compilation DEBUG_LOCKORDER peut également exiger le verrou du mempool global. Pour ces nouveaux scénarios, utiliser le contexte canonique global ou un dispositif explicitement revu qui démontre la cohérence de toutes les vues et de leurs verrous. Ne pas modifier l'implémentation consensus pour faire passer ce test.

### R4 — Blocage de qualification réel : absence de décision/profil final et preuves encore exigées

La spécification DOGECOIN_ADAPTER_SPEC_V1.md:178–194 interdit de figer un profil avant la preuve de construction wallet, compatibilité signataire externe et matériel, sighash exact, hypothèses de malléabilité et fiabilité de récupération. D2:491–494 exige ensuite de figer les octets et la version. Ces conditions sont plus larges que les 24 entrées du catalogue et restent incomplètes.

Le plan DOGECOIN_D2_COMPLETION_PLAN_2026-10-30.md demande aussi les contextes CLTV avant/après activation ainsi que les domaines/cutoffs de finalité. L'ancien diagnostic observe l'activation et exécute des contrôles C ABI avec une fixture ancienne ; le candidat signé à clés distinctes est démontré après activation à hauteur1352, pas dans une séquence signée avant/après activation ni dans des cas timestamp/MTP confirmés. Les futures qualifications D3 peuvent fournir cette preuve, mais elles ne doivent pas être supposées déjà acquises.

Les trois préflights logiciels acceptés dans le catalogue restent des modèles séparés. Ils ne prouvent pas que le pipeline réel de signature/récupération vérifie les intentions, le montant de la sortie et le plafond de frais. Le contrôle legacy ne signe pas le montant de l'entrée. L'intégration réelle de ces vérifications demeure indispensable à la qualification financière.

Ne retirer aucune de ces conditions seulement pour afficher PASS. Le travail sur des expériences distinctes et explicitement non qualifiées D3/D6/D7 peut continuer sans promouvoir un état dépendant.

## Décision scénario par scénario

Les mentions PASS ci-dessous portent **sur le prédicat déclaré et le type de mesure**, pas sur la phase entière. Le catalogue 24 cas, SHA256 b342a03deb7f4149221964bb984453eed7530365e3f7cf486fd261004af618b5, conserve ses trois types de mesure.

| Scénario | Décision sur sa preuve | Justification et limite |
| --- | --- | --- |
| valid_claim | PASS — natif D0 | Signature indépendante valide, admission sous standardness imposée et confirmation. |
| valid_refund_after_lock | PASS — natif D0 | Alias valid_refund_after_crash ; signature valide, persistance avant lock, récupération après SIGKILL/reindex et clés supprimées, admission et confirmation. |
| early_refund | PASS — natif D0 | C ABI accepte le script ; sendrawtransaction rejette non-final à hauteur1353 pour lock1355. |
| equal_candidate_height_nonfinal | PASS — natif D0 | Après minage du claim à1354, prochain bloc1355 égal au lock ; rejet non-final. |
| wrong_signature | PASS — natif D0 | Signature réellement invalide pour le digest attendu, C ABI0 et rejet node script-verify. |
| wrong_claim_key | PASS — natif D0 | Signature issue du mauvais rôle, invalide pour la clé claim attendue ; C ABI0 et rejet node. |
| wrong_refund_key | PASS — C ABI D0 | Mauvais rôle refund ; C ABI0, pas de preuve séparée d'admission revendiquée. |
| wrong_secret | PASS — natif D0 | Signature correcte mais préimage incorrecte ; C ABI0 et rejet node. |
| short_secret | PASS — natif D0 | Signature correcte ; taille31 au lieu de32 ; C ABI0 et rejet node. |
| wrong_redeem | PASS — natif D0 | Redeem modifié ne correspond plus au P2SH financé ; C ABI0 et rejet node. |
| lock_domain_mismatch | PASS — C ABI D0 | Signature correcte, lock timestamp500000000 face à operand hauteur1355 ; C ABI0. |
| changed_signed_lock | PASS — C ABI D0 | Mutation post-signature, ECDSA indépendant invalide ; C ABI0. |
| wrong_outpoint | PASS — C ABI D0 | Mutation de l'outpoint signé, ECDSA indépendant invalide ; C ABI0. |
| wrong_destination | PASS — C ABI D0 | Mutation de sortie post-signature ; ECDSA indépendant invalide ; C ABI0. Cela ne teste pas une destination indue valablement resignée. |
| final_sequence | PASS — natif D0 | Signature correcte ; séquence finale, C ABI0 ; le node arrive au rejet de script, pas à non-final. |
| wrong_input_value | PASS — préflight logiciel | Le modèle rejette montant/identité/script incohérents ; tests rerun. Ne prouve pas une intégration native ou une propriété du sighash legacy. |
| double_spend | PASS — natif D0 | Sortie0 déjà confirmée dépensée par le claim ; nouveau spend signé rejeté bad-txns-inputs-spent. |
| absent_utxo | PASS — natif D0 | Signature correcte pour un outpoint absent, gettxout null, rejet Missing inputs ; pas assimilé à échec de script. |
| immature_coinbase | PASS — natif D0 | Coinbase réelle à une confirmation, signature correcte ; rejet premature-spend-of-coinbase. |
| hard_dust | PASS — natif D0 | Signature correcte, sortie1 koinu ; rejet dust. Ce cas ne mesure pas les deux côtés exacts du seuil hard-dust. |
| soft_dust_reserve | PASS — diagnostic source | Vraie fonction GetDogecoinDustFee aux seuils, cumul et exemption OP_RETURN ; 10 assertions. Ne prouve pas à lui seul un parcours complet de relais. |
| dynamic_mempool_fee_floor | PASS — diagnostic source | Eviction native bornée, floor mesuré exactement, même candidat précédemment accepté rejeté pour mempool min fee not met ; 16 assertions. Entrée de pression injectée non admise, pas une saturation réseau. |
| excessive_fee | PASS — préflight logiciel | Le modèle de plafond rejette EXCESSIVE_FEE ; aucune preuve d'un plafond intégré à un signataire réel n'en découle. |
| script_flag_override | PASS — préflight logiciel et configuration examinée | Modèle refuse l'override ; commande/config de l'expérience impose standardness et ne fournit aucun override. |

### Contrôles supplémentaires examinés

Les signatures et les rejets de changed_signed_amount, changed_signed_sequence et noncanonical_der sont cohérents. Les signatures high_s_policy, extra_stack_policy, nonminimal_push et oversized_scriptsig sont mathématiquement valides ; le C ABI à flags517 les accepte tandis que la politique du node les rejette. nonpush_only_scriptsig est rejeté par P2SH/politique. bare_htlc_output est un spend correctement signé dont la sortie brute est non standard.

Les contrats négatif CLTV, operand six octets et 16 sigops sont liés à des sorties financées réelles à100 DOGE. Les signatures indépendantes sont valides et nLockTime=0, donc les deux rejets de script ne peuvent pas être expliqués par une finalité future ni une mauvaise signature. Le cas16 sigops a quatorze CHECKSIG dans une branche inexécutée et les deux CHECKSIG du contrat ; C ABI valide, AreInputsStandard rejette bad-txns-nonstandard-inputs.

Les C ABI flags517 sont P2SH|DERSIG|CLTV, pas l'ensemble STANDARD_SCRIPT_VERIFY_FLAGS. Le source standard à policy/policy.h:88–105 inclut notamment LOW_S, MINIMALDATA et CLEANSTACK. L'admission native effective et ses contrôles différentiels apportent la preuve de politique ; le résultat du C ABI seul ne doit pas être surinterprété.

Le diagnostic PR351 démontre réellement la reconstruction du remboursement avec clé encore disponible et confirmation sous budget fixe : ancien frais1 000 000 koinu, minimum mesuré32 708 662, choix/plafond100 000 000, sortie99 DOGE, hauteur1354. La première transaction a été retirée du pool : ce n'est pas un remplacement RBF d'une transaction toujours en attente. Le code choisit délibérément le plafond de fixture ; il ne démontre pas une optimisation de frais de production.

## Ce que cette revue permet et ne permet pas de décider

- Accepter la cohérence des preuves conservées pour les 24 prédicats déclarés et les contrôles supplémentaires examinés.
- Corriger R1 et R2 sans effacer les anciens résultats ; documenter R3 pour les extensions natives.
- Préparer un profil de candidat explicitement versionné et non activé, puis combler les conditions de R4 avant tout D2 PASS global.
- Continuer les travaux concrets D3, D6 et D7 dans leurs environnements privés, avec qualification toujours bloquée lorsque les prérequis manquent.
- Garder NOT_TESTED pour les matériels indisponibles et BLOCKED pour l'audit D9 humain externe non réalisé.

Aucune promesse de récupération si le signataire disparaît et si les frais requis dépassent tous les remboursements déjà signés. Aucune preuve multi-nœuds, propagation P2P, partition, reorg profonde ou récupération sur un environnement réellement indépendant ne figure dans les preuves examinées. Un invalidate/reconsider sur un nœud ne suffit pas pour D6 ; un digest conservé dans le même processus ne suffit pas pour D7.

Les workflows actuels examinés sont manuels uniquement (workflow_dispatch). Les anciens déclencheurs temporaires de runs historiques ne satisfont pas le nouveau mode opératoire de la mission et ne doivent pas être réintroduits. Ils ne sont pas une raison de falsifier les preuves historiques : toute nouvelle expérience à effet doit suivre le lancement manuel demandé.

## Réponse aux corrections

R1 est corrigé par register_fixture : une retransmission connue reste permise à 32 fixtures uniques ; la 33e fixture nouvelle reste refusée. Un test de régression passe. R2 est corrigé : les limites du runner sont distinguées de la décision consolidée. R3 reste une limite explicite : les nouveaux diagnostics D3 ne revendiquent aucun ancêtre non confirmé/CSV ; les extensions futures doivent revoir le pool global. La décision de qualification reste BLOCKED.
