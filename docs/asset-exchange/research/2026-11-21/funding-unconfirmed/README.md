# Refus natif d'un financement non confirmé — preuve interne

Le [run44652078768](https://github.com/khemisset18/gpubnb/actions/runs/44652078768)
a exécuté **un seul nouveau cas**, sans répéter les deux cas reorg/remboursement
déjà réussis. Le harnais figé est `555419d73ff0430f862a7836ef11e129e273b980` ;
l'exécution est `3aea3b7f5cfb499ae9754f04e24223ce11d3ae02`. Le seul delta
entre leurs arbres Git est l'épingle du harnais dans le workflow manuel existant.

Les transactions publiques antérieures de financement et remboursement sont
admises dans le mempool du nœud A, sans créer de clé ni de signature. Le tip
natif reste à **1355 blocs et 1355 en-têtes** : aucune avance d'en-têtes ne
masque cette fois le contrôle de financement. Les deux transactions ont zéro
confirmation et aucune ancre de bloc. Le runtime autonome observe le remboursement
PENDING avec `fundingConfirmed:false`, puis refuse exactement :

> funding is not confirmed on active chain; no broadcast

**Résultat borné : 1 PASS / 0 FAIL / 0 SKIP sélectionné.** Zéro diffusion par le
runtime de récupération, zéro bloc généré, deux admissions publiques préexistantes,
deux invocations autonomes et zéro clé/signature nouvelle. Les compteurs natifs
se recoupent : **53 appels client =35 directs +18 autonomes ; 49 reçus par les
daemons =37 A +12 B ; quatre tentatives de disponibilité sans serveur**. Les
limites400 appels, deux blocs et huit invocations restent inchangées.

L'[archive14591413354](https://github.com/khemisset18/gpubnb/actions/runs/44652078768/artifacts/14591413354)
a été téléchargée, bornée et vérifiée :187701octets, SHA256
`2bf772edc65124f50c09724b64ba27bc23448e2903ee592f293027c446b1e413`.
Ses quatorze entrées et sept sommes internes sont vérifiées. Le reçu machine
conserve D0/D1, les identités et sujets des attestations vérifiées dans CI, les
arbres exacts, les compteurs, transactions et limites. La vérification
cryptographique des attestations est attribuée au helper CI réussi ; elle
n'est pas présentée comme une nouvelle vérification cryptographique locale.

Les sept sources embarquées correspondent à AC28, au harnais et à l'exécution.
Le zipapp reproduit deux fois retrouve
`690a26f739217fb19701b5dc5ee3c6abac747b28e3ebaf7014c29897806c3f73`,
avec le cœur `ab6221fb209ac05316a37d9b17beb26ad45317b125dd0c1866abf3d3240a1c8b`.
Les préflights du job conservent51 tests D6,12 signataire logiciel,37 récupération
et24 watchers PASS ; les suppléments D7/D8 intégrés ont leurs preuves séparées.

Les fichiers de `native-selected/` sont copiés sans réécriture. Leur manifeste
d'origine référence aussi les journaux daemon et requêtes restés dans l'archive
complète. Le vérificateur utilise cette archive et son extraction bornée :

```bash
python3 verify_native_44652078768.py ARTIFACT_DIRECTORY REPOSITORY OUTPUT_JSON
```

Cette commande vérifie des fichiers et reproduit le paquet ; elle ne lance aucun
daemon, aucune signature et aucune transaction. La revue n'a relancé aucun cas.

Ce cas isole désormais le garde de financement. Il porte sur le nœud A et
n'ajoute pas de consensus watcher à observations appariées ni de remboursement
confirmé : ces résultats gardent leurs exécutions distinctes. Les jobs VM non
sélectionnés restent SKIP. D0–D9 complets et qualification financière restent
BLOCKED ; audit externe indépendant NON RÉALISÉ, hors mission. Aucun Mainnet,
fonds réel, merge ou déploiement.
