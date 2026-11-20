# DOGE — contrôle natif du financement non confirmé, 20 novembre 2026

**Préflight logiciel : PASS. Nouveau contrôle natif : À EXÉCUTER sur le
laboratoire privé existant.** Ce dossier prépare uniquement la preuve manquante
du refus direct de récupération lorsque le financement est en mempool. Aucun
résultat natif n'est inventé et aucun audit externe n'est requis pour l'exécuter.

## Preuve déjà acquise, sans nouvelle exécution

Le candidat PR376 `ac28d513abd8084842c14de7cdc92765164bbc8a` contient les
corrections de snapshots RPC. Ses deux scénarios de non-régression native sont
déjà PASS dans [44400212431](https://github.com/khemisset18/gpubnb/actions/runs/44400212431),
harnais `a3eef9d38e4418c80269dc521c35c895caee77e5`, exécution
`4ce481379a9355d5aa49e92ebe93df032e0a6906`.
Leur artefact14472149211 porte le SHA256
`7191906e1af4543fc0bd53885f1d2ab0e8534a02bad85f10b5b5da3359cecfe4`.

Ces deux scénarios ne sont pas sélectionnés par le nouvel incrément. Leur ancien
format reste recevable : le nouveau vérificateur a relu hors ligne le rapport
natif conservé, a accepté ses quatre étapes et a maintenu `settlementAllowed:false`.
Aucun daemon ni RPC n'est exécuté lors de cette lecture.

Dans le rollback conservé, l'en-tête1356 reste connu tandis que la chaîne active
revient à1355. Le garde d'en-têtes refuse donc avant le garde direct du financement.
Ce comportement correct explique la preuve manquante ; il ne justifie aucun
affaiblissement ou réordonnancement des protections.

## Nouveau cas sélectionné, et lui seul

`unconfirmed-funding-refuses-rebroadcast` utilise l'exécuteur existant
`recovery-funding-reorg` et la branche privée
`asset-exchange/doge-recovery-consistency-20261112`. Les workflows, les gardes de
dépôt/branche/événement, les sources D0/D1, le runtime autonome, le signataire et
la liste des refus autorisés restent identiques à ac28.

1. Relire et vérifier le bundle public conservé, son empreinte indépendante et
   les deux transactions déjà signées. Les clés d'origine sont absentes.
2. Réimporter les1355 blocs publics vérifiés sur les deux nœuds privés. Vérifier
   `headers == blocks == 1355` sur A.
3. Admettre sur A les octets existants du financement puis du remboursement.
   Ne miner aucun bloc. Vérifier que les deux TXID sont dans le mempool, que les
   octets sont inchangés et que les deux transactions ont zéro confirmation.
4. Depuis l'outil autonome avec backend/clés masqués, observer `PENDING` avec
   `fundingConfirmed:false`, puis demander la retransmission.
5. Exiger le refus exact `funding is not confirmed on active chain; no broadcast`,
   zéro appel de diffusion par l'outil autonome et le tip1355 inchangé. L'avance
   d'en-têtes ne doit pas expliquer le refus. Les deux admissions de préparation
   sont distinguées de l'absence de diffusion pendant le refus.

| Ressource | Effet du nouveau cas | Limite existante inchangée |
| --- | --- | --- |
| Nœuds | Deux, privés et loopback uniquement | Deux |
| Blocs importés / générés |1355 / **0** |1355 /2 |
| Fixtures admises | Deux transactions publiques déjà signées | Deux |
| Outil autonome | Deux invocations : observation et refus | Huit |
| RPC | À mesurer et rapprocher des journaux natifs |400, outil autonome inclus |
| Nouvelles clés / signatures | **0 /0** | Création interdite |

`multinode.py` sélectionne explicitement `run_unconfirmed_funding` et lui passe
un contexte sans fonction de minage. L'ancienne fonction `run_funding_reorg`
reste disponible pour l'interprétation des sources historiques ; elle n'est pas
appelée par ce nouvel incrément. Aucun nouveau mode de production ou protocole
financier n'est introduit.

## Vérification logicielle et relecture interne

Les **51 tests D6 passent, zéro échec/ignoré** : les45 contrôles existants et six
nouvelles méthodes. Ils vérifient la sélection seule, les bornes inchangées, le
rejet avant tout accès natif si le bundle/les clés ne conviennent pas, et le
refus d'une preuve attribuant à tort le résultat au garde direct.

Le contrat de preuve exige un seul schéma natif, les identités canoniques, un
seul nouveau cas, zéro bloc, exactement deux invocations, le résultat attendu
`UNKNOWN / EXPECTED_REFUSAL / BLOCKED` et aucune diffusion autonome. Quatorze
mutations adverses sont refusées. Les anciennes preuves de reorg restent validées.

La relecture QA a révélé puis fait corriger un vrai défaut du nouveau contrat :
si le TXID manquait dans les deux objets, `undefined === undefined` suffisait à
la comparaison. La preuve fabriquée sans identités était acceptée par le source
`fa55bca9b2dc7e0b837533abe96f9390e3f8d9ac` (exit0), puis refusée après contrôle
canonique (exit1). Ce reproducer est strictement logiciel, sans nœud, clé,
signature ou RPC. Le défaut ne concerne pas le protocole de transaction.

Les commits locaux de code sont `fa55bca9b2dc7e0b837533abe96f9390e3f8d9ac`, puis
`2dfd48e5e9ec16da45acfcf14ca3d096ff5dfdba`. Le
[reçu logiciel](research/2026-11-20/unconfirmed-funding/software-result.json), les
[empreintes de sources](research/2026-11-20/unconfirmed-funding/source-index.json),
le [manifeste](research/2026-11-20/unconfirmed-funding/effective-manifest.json) et
les journaux sont indexés par SHA256. La prochaine exécution devra conserver
ses vrais SHA H/E, compteurs, preuves natives et artefact avant de promouvoir ce
contrôle en PASS natif.

## Critères D2–D6 : périmètre technique et prérequis

| Phase | Déjà démontré, sans répétition | Condition restante précise |
| --- | --- | --- |
| D2 |32 contrôles natifs,24 prédicats typés, signatures et différence C ABI/politique examinées ; [42875442068](https://github.com/khemisset18/gpubnb/actions/runs/42875442068) | Le gel de profil selon SPEC §7 exige aussi construction wallet, signataire externe et **matériel**. Le profil reste `CANDIDATE_NOT_APPROVED` et le matériel `NOT_TESTED`. La nouvelle revue interne ne remplace pas ce matériel. |
| D3 |2357 assertions sélectionnées : activation CLTV, hauteur/temps/MTP, versions/séquences, six sighashes et malléabilité ; [43060202035](https://github.com/khemisset18/gpubnb/actions/runs/43060202035) | Pas de nouvelle lacune de ces contrôles inchangés. Le critère complet dépend du profil final D2. CSV/SegWit demeurent désactivés. |
| D4 | Financement/claim/refund, refus secrets/clés/termes, bundle avant lock, récupération sans clés, nouveau cœur confirmé dans [44400212431](https://github.com/khemisset18/gpubnb/actions/runs/44400212431) | La nouvelle preuve directe de financement non confirmé reste à exécuter. Le chemin financier intégré complet et ses prérequis ne sont pas prouvés par les seuls essais de fixtures ou les tests Solana hôte. |
| D5 | Frais, limites dust, relais/wallet/miner distincts, pression/pinning, refus au plafond et reprise ; [43108343770](https://github.com/khemisset18/gpubnb/actions/runs/43108343770), limites RBF puis [43484240757](https://github.com/khemisset18/gpubnb/actions/runs/43484240757) | Les objectifs bornés sont établis. Une garantie de frais arbitraires n'est pas exigée par la grille : refuser au-delà de l'échelle signée est le comportement attendu. La phase complète reste liée aux prérequis D4/profil final et à ses limites financières explicites. |
| D6 | Partitions, forks/reorg/reconvergence, confirmations rétrogradées, conflits/incertitude/staleness,8+12 contrôles AuxPoW et12 sorties d'erreur explicites examinées ; [43311713839](https://github.com/khemisset18/gpubnb/actions/runs/43311713839), [44400212431](https://github.com/khemisset18/gpubnb/actions/runs/44400212431) | La preuve préparée ici ferme un manque natif borné si elle passe réellement. Les prérequis D1/D4/D5 du profil final restent applicables. Aucun fuzzing exhaustif n'est exigé par la grille ; son absence ne constitue pas à elle seule un échec de ces scénarios. |

La course entre snapshots RPC reste isolée en logiciel ; l'ancien run natif
prouve la non-régression du runtime, pas une injection native de cette course.
Des appels RPC distincts ne garantissent pas un snapshot atomique jusqu'à la
diffusion. Ces limites ne sont pas effacées par le nouveau test de financement.

Les contrôles de sécurité obligatoires et le candidat intégré exact déterminent
la qualification interne globale. L'audit externe indépendant D9 reste **NON
RÉALISÉ**, hors mission. Aucun merge, Mainnet, fonds réel, clé utilisateur,
activation des directions ou déploiement financier n'est réalisé ici.
