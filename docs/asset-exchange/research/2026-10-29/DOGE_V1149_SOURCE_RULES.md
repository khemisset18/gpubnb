# Règles DOGE v1.14.9 — constat de source, sans exécution D2–D9

Source exacte : e0a1c157791544e818c901bd9341896965afbf9d ; URLs et hashes des
fichiers dans SOURCE_INVENTORY.json. Les observations D1 déjà acquises restent
l'unique contrôle exécutable DOGE de cette mission. Les tests cités ici sont
présents upstream, pas exécutés par nous.

| Sujet | Règle lue dans cette version | Conséquence de qualification |
| --- | --- | --- |
| P2SH | validation.cpp impose SCRIPT_VERIFY_P2SH ; interpréteur et politique distincts | Comparer consensus et standardness ; vérifier redeem script et hash exact |
| CLTV | validation.cpp active à BIP65Height ; chainparams : main 3464751, test 1854705, regtest 1351 | Une chaîne D1 à hauteur 0 ne prouve pas CLTV actif ; futur test nécessite autorisation de créer la chaîne adéquate |
| CSV/BIP68/BIP113 | traitement conditionnel à THRESHOLD_ACTIVE de DEPLOYMENT_CSV ; paramètres hérités présents | Code et paramètres ne prouvent pas une activation historique. D1 regtest : état defined ; aucune dépendance CSV autorisée |
| SegWit | IsWitnessEnabled retourne explicitement false | Pas de P2WSH/SegWit ni de stabilité txid héritée de BTC |
| Signature | ECDSA historique ; SignatureHash et contrôles de types dans script/interpreter.cpp | Vecteurs propres à DOGE ; éviter SIGHASH_SINGLE/ANYONECANPAY non approuvés ; pas de BIP143 importé |
| nLockTime | IsFinalTx compare hauteur ou temps selon seuil 500000000 ; égalité non finale ; séquence finale désactive la contrainte transactionnelle | Tester avant/à/après, type et nSequence ; ne pas utiliser l'horloge murale seule |
| MTP | sélection BIP113 conditionnelle à CSV ; mempool et consensus ont des contrôles distincts | Ne pas présumer les règles Bitcoin actuelles identiques |
| Standardness | policy/policy.h : MAX_STANDARD_TX_WEIGHT 400000, MAX_P2SH_SIGOPS 15 ; policy.cpp applique les types/limites | Cap de taille standard ne constitue pas à lui seul un verdict de consensus |
| Frais | COIN=100000000 ; recommandé 1000000 koinu/kB (0.01 DOGE/kB), relay par défaut 100000 koinu/kB, incrément 10000 koinu/kB | Conversion exacte et profil de taille sérialisée ; recommandations ≠ coût garanti |
| Dust | soft 1000000 koinu ; hard 100000 koinu par défaut | Tester frontières par sortie et type ; ne pas copier une règle BTC/vB |
| RBF | mempool examine signalement, conflits, descendants, total des frais et incrément | Un remplacement admis peut casser les références de refund pré-signé ; pas de promesse de fee bump universel |
| AuxPoW | paramètres et validation dédiés, activation main à partir de 371337 | Le parseur d'en-tête/bloc et les fixtures ne doivent pas être ceux de BTC sans adaptation |
| Reorg | sélection de chaîne et index invalidables ; aucune finalité déterministe offerte par un nombre de confirmations | Watchers indépendants, historique de bloc, réévaluation des expirations et arrêt sur conflit |
| RPC | API ancienne et format CLI particulier ; aucune ACL native par méthode constatée dans D1 | Future allowlist explicite par phase ; pas d'appel wallet/signature/minage/broadcast autorisé aujourd'hui |

Attention : src/amount.h contient un MAX_MONEY pour le contrôle des montants ;
ce plafond de validation ne constitue pas une affirmation de supply maximale.
Les valeurs de politique peuvent être configurées. Le doc/bips.md upstream
précise lui-même une mise à jour jusqu'à v1.14.6 : le code épinglé prévaut.

Tests de référence à inventorier pour la prochaine revue : script_tests et
sighash_tests dans src/test ; qa/rpc-tests/bip65-cltv.py et
bip68-112-113-p2p.py ; tests de mempool replacement et AuxPoW. Leur existence
n'active ni CSV ni CLTV à hauteur zéro. Les futures preuves D2/D3 devront
indiquer exactement réseau, activation, hauteur, transactions et permissions.
