# Correspondance modèle/code — candidat 17bb

Cette revue interne relie les modèles existants au code et aux tests effectivement
exécutés. Elle ne modifie aucun modèle ni invariant et ne constitue pas une preuve
mécanisée de raffinement ou un audit externe. Référence exécutable :
17bb3e2e7774d97538305759e706de6f6a8da0d1, arbre4fb75f3aab95895b8d841e240932cad083687fc6.

Les fichiers .tla/.cfg, runners .sh et workflow formel sont identiques à
bef36cb9f45bb130b0533d9aea39f6573d894255 : diff Git vide. Les résultats bornés
historique du README formel restent à leurs propres commits et hypothèses.
Aucun nouveau passage TLC n'est inventé ou répété ici.

| Modèle / action / invariant | Code et donnée correspondante | Test ou preuve | Limite explicite |
| --- | --- | --- | --- |
| AssetExchangeV1.SignTerms / NoUnsignedLock | core/src/state-machine.mjs : createTradeState exige termsFinalized ; transitionTrade n'autorise le lock qu'après RECOVERY_READY | core/test/state-machine.test.mjs : refus sans termes finalisés et sans bundle prêt ; Foundation44952572254 | Machine pure : les booléens d'évidence ne prouvent pas à eux seuls la chaîne ni une intégration de règlement active |
| GenerateBundle, ValidateBundle, ExportBundle / RecoveryBeforeLock | recovery/dogecoin/recovery_core.py : persist_bundle valide, écrit exclusivement en 0600, fsync fichier/répertoire, relit avec hash avant de rendre le reçu | test_recovery.py : bundle durable/exclusif, mauvaise empreinte/symlink, erreur fsync ; test_process_crashes.py : 7frontières réelles SIGKILL | La remise du reçu doit précéder le lock dans l'appelant ; aucune permission de financer ne découle d'un reçu absent |
| EpochFence / BroadcastALock et BroadcastBLock | state-machine.mjs : policyEpoch du command égal au trade avant chaque lock | test « stale epoch cannot create a new lock » | Pas de nouveau lock DOGE de production activé |
| UncertainChainStopsAdvance / ObserveEvidence | chain-watchers/src/evidence.mjs et dogecoin-observation.mjs ; recovery_core.observe/active_confirmation : quorum, réseau, tip, hauteur, profondeur et ancre active | evidence.test.mjs, dogecoin-observation.test.mjs, test_rpc_consistency.py ; reorg natif44400212431 | Les lectures RPC multiples ne sont pas une transaction atomique ; changement détecté entraîne refus/retry et le daemon revalide |
| NoResultBeforeEffect / RecordBroadcastResult | rebroadcast vérifie acquittement du txid puis observe indépendamment les octets et état PENDING/CONFIRMED ; un simple acquittement ne suffit pas | test_recovery.py : remboursement exact ; preuves cleanroom natives ; SBF a aussi ses propres refus et snapshots indépendants | Les événements SBF concernent GPU escrow, pas une preuve additionnelle de consensus DOGE |
| FaultsV1.PersistIntent / IntentBeforeEffect | Bundle présigné immutable et reçu séparé précèdent toute retransmission ; journal d'observation lié au bundleSha256 | test_process_crashes.py et test_recovery.py : persistence préalable, journal atomique, 0clé en enfant | Le journal est une observation ; il n'est pas présenté comme une base de lock production à lui seul |
| CrashWorker, RestartWorker, ReconcileExistingEffect / CrashIdempotency | save_observation : temporaire/fsync/rename/fsync ; reprise réutilise le même txid et les mêmes octets présignés ; CONFIRMED rend ALREADY_CONFIRMED |17 interruptions SIGKILL : 7bundle, 7journal, 3send/restart en modèle RPC ; 15 incidents VM historiques ; 44400212431 natif sur cœur actuel |3frontières send/restart nouvelles utilisent explicitement un modèle RPC logiciel ; aucune coupure secteur revendiquée |
| SpendRaceV1.NoDoubleSpend / ObservationConsistent | observe refuse deux remboursements actifs, confirmed/pending contradictoires, refund et UTXO non dépensé ; watcher maintient les conflits | test_rpc_consistency.py : conflits multiples et UTXO ; native D4 et D6 existants | Aucun choix arbitraire d'une première observation ; la finalité reste un fait de chaîne réévalué |
| BecomeRefundEligible / RefundOnlyAfterMaturity | rebroadcast compare nLockTime à hauteur suivante ou MTP selon le seuil ; signature et script restent liés aux octets | test_recovery.py : égalité non finale ; D3 natif43060202035 : 2357 assertions et 6sighashes | CSV inactif/non utilisé n'est pas activé par analogie Bitcoin |
| TermsV1.TermsImmutable, FeeTermsImmutable, LockUsesSignedTerms | wallet-agent/dogecoin/refund_ladder.py : common_terms, validate_refund_signing_request, validate_signed_refund et finalize_refund_signing_response | test_refund_ladder.py ; test_signer_boundaries.py : reçu séparé, permutations de signatures, mutations/DER/sighash/high-S, 16 tests PASS | Validation publique logicielle ; ne prouve aucun écran ou firmware matériel |
| RecoveryCompositionV1.ExchangeCannotGateRefund / FeeCannotGatePrincipalRecovery / KycCannotGatePrincipalRecovery / TransitionCannotGatePrincipalRecovery | Zipapp public autonome ; aucun import API/Prisma, clé d'origine ni backend dans recovery_core ; sélection d'un remboursement déjà signé | test « standalone package … empty cwd », policy zipapp isolé, VM43111959236, natifs44400212431 et 44652078768 ; Core import isolation en CI | Le plan présigné couvre un plafond fini ; au-delà, refus sûr. Le modèle n'autorise aucune promesse de frais arbitraires |
| HonestRecoveryPath / RecoveryDuringMarketplaceStop | Action de reprise reste possible avec bundle vérifié, chaîne qui progresse et tarif couvert, sans backend | TLC historique avec hypothèses de fairness ; remboursement natif et VM réels conservés | Pas de liveness sous panne permanente de chaîne/réseau ou absence permanente d'action requise du participant |

Tous les chemins sont relatifs à asset-exchange/. Les noms de tests Python
désignent les fichiers existants du candidat. Les suites logicielles concernées
passent dans Foundation44952572254 ; les historiques natifs ne sont pas comptés
comme de nouvelles exécutions de ce commit.

## Revue critique

- Un hash contenu dans un colis modifié ne remplace jamais le reçu indépendant.
  Les contrôles de bundle, signatures et txid canoniques restent nécessaires.
- Un état purement logiciel ou un nombre de confirmations déclaré par RPC ne
  remplace pas l'ancre active, son contexte et les observations cohérentes.
- L'ancien et le nouveau programme SBF ont la même source financière et 38 reçus
  ABI identiques ; le changement SDK reste couvert par de vraies exécutions ELF.
  Les précompiles optionnels non utilisés ne sont pas qualifiés.
- Les modèles bornés ne comprennent pas un appareil matériel réel. D8 reste
  bloqué ; un refus d'un profil non pris en charge est un succès de refus sûr,
  pas une compatibilité matérielle.
- G4 complet reste ouvert à une revue plus large des compositions/hypothèses.
  La présente correspondance documentée clôt l'absence de carte de lecture pour
  ce candidat ; elle ne transforme pas les preuves bornées en preuve universelle.

Aucune propriété formelle, protection ou condition PASS n'a été affaiblie.
