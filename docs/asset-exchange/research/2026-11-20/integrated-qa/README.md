# Vérification QA interne du 20 novembre 2026

Le code de référence est `ac28d513abd8084842c14de7cdc92765164bbc8a`, arbre
`ecba7bcbae006f2850b3cfeae636a1a92284a60c`. Les résultats natifs du
[run44400212431](https://github.com/khemisset18/gpubnb/actions/runs/44400212431)
ont été retéléchargés et contrôlés, sans relancer les deux cas inchangés.

`native-44400212431-result.json` fixe l'archive, ses quinze entrées, les huit
sommes internes, les identités D0/D1 et attestations déjà vérifiées dans CI,
le delta Git exact harnais/exécution et les sept sources du runtime. Le zipapp
reproduit deux fois correspond au paquet natif. Les preuves natives sélectionnées
sont copiées sans réécriture dans `native-selected/` ; les journaux complets et
requêtes sont conservés dans l'archive GitHub identifiée par sa somme.

Les compteurs de ce run sont **175 appels client, 171 reçus par les daemons
(118/53), quatre tentatives de disponibilité sans serveur**, deux blocs et six
invocations autonomes. Les 177/173 appels d'une autre campagne ne sont pas
attribués à celle-ci. Aucun nouveau test natif, clé ou signature pour cette revue.
Le refus historique d'avance d'en-têtes intervient toujours en premier : ce run
n'isole pas le nouveau garde de financement ni les mutations RPC testées en logiciel.

La matrice des neuf workflows du candidat conserve huit SUCCESS et le FAIL du
scanner strict. Le prototype GTK a son propre arbre et un run strict avec Borsh
seul ; ses validations GUI/plateformes et la migration Anchor sont distinctes.
Ces reçus n'accordent ni qualification financière complète, ni audit externe.

Reproduction de la vérification, après téléchargement borné de l'archive et
extraction sûre dans un répertoire contenant `artifact.zip` :

```bash
python3 verify_native_44400212431.py ARTIFACT_DIRECTORY REPOSITORY OUTPUT_JSON
```

Cette commande vérifie des fichiers et reproduit le paquet ; elle ne lance
aucun daemon, aucune signature et aucune transaction. Aucun contrôle de sécurité
n'a été abaissé et aucun merge ou déploiement n'a été effectué.
