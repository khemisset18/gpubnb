# DOGE — stabilisation du 15 novembre 2026

Qualification complète **BLOCKED**. Régression native ciblée : **2 PASS / 0 FAIL / 0 SKIP**.

## PR #364 : diagnostic du refus natif

La branche distante a été relue à `3866ddd1229fec81e5abfbf6a268309669cf262d`.
Les runs manuels `43486987680` (SHA `4766d0de2468acdaa04ed6b8fef1ac7f7dd74b58`)
et `43487873755` (SHA `496664163fb3242be3f56e5bee439c018c874330`) sont FAIL.
Leurs correctifs de préparation IBD puis d'attente du garde d'en-têtes existent
déjà dans ce HEAD ; aucun run manuel de ce HEAD n'était présent à la lecture.

L'archive du deuxième run, artefact `14067004885`, a été téléchargée et son
SHA256 vérifié : `60d434157830d308f754dc47332badf1016c843c7a9791a9844b73f525beb59d`.
Son rapport observe le remboursement PENDING avec financement confirmé, puis
PENDING avec financement non confirmé après rollback. Il échoue sur une attente
de motif de refus différente. Le JSON effectif de ce refus manque à l'archive :
son motif exact n'est donc pas une observation native conservée.

Un test logiciel reproduit cette perte de diagnostic : **6 PASS / 1 FAIL / 0 SKIP**.
Le laboratoire conserve désormais le JSON d'un refus appartenant à son schéma
fermé et à sa liste de messages publics, avant de comparer le message attendu.
Une différence reste un échec ; aucune tolérance supplémentaire n'est ajoutée.
Un second test vérifie que l'avance d'en-têtes garde sa priorité lorsque le
financement est aussi non confirmé, avec zéro appel de diffusion.

Les fichiers financiers `recovery_core.py`, les signatures et les règles RPC
restent identiques à la base. Les résultats locaux sont : récupération **30/0/0**,
laboratoire D6 **45/0/0**, signataire logiciel **12/0/0**, watchers **24/0/0**
(PASS/FAIL/SKIP). Le [reçu logiciel](research/2026-11-15/recovery-diagnostics/software-result.json)
contient les empreintes de sources et journaux, ainsi que la plateforme.
Le test de priorité utilise des RPC simulés et ne remplace pas une preuve native.

## Exécution native obtenue après authentification

Le connecteur ne permet pas de lancer un nouveau workflow. Après connexion
sécurisée, l'entrée manuelle existante a été lancée dans GitHub ; aucun
contournement du routage manuel n'a été ajouté. Le reçu logiciel précédent
reste un instantané antérieur à cette connexion, sans réécrire son statut.

Le run [43760009110](https://github.com/khemisset18/gpubnb/actions/runs/43760009110)
exécute `e3fbbe6339d2eaecc6bd999daf2d9fe7fb6a1816`, avec le harnais
`d551db512b070dfa85bc72b068df07ca99127d3f`, sur Ubuntu 24.04.
Les deux cas passent : refus pendant le rollback, puis retransmission des
octets identiques après restauration et confirmation sur les deux nœuds.
Le JSON retenu atteste le refus exact du garde d'en-têtes. Aucun appel de
diffusion n'a lieu pendant ce refus ; aucune clé ni signature n'est créée.
Le test natif n'isole pas le nouveau garde de financement : il est isolé par
le test logiciel, tandis que le garde d'en-têtes préexistant refuse en premier.

Les quatre étapes watcher restent sans progression ni règlement, avec état
UNCERTAIN pendant la partition. Consommation : deux blocs, 173 RPC et six
invocations autonomes, sous les limites inchangées de 2 / 400 / 8.
L'artefact `14179763049` a été téléchargé et vérifié : SHA256
`1771c3b4f504949bbe615891703ed03289d9449c1702430720d080325cd5ef3d`.
Les contrôles logiciels du job donnent 45 + 12 + 30 + 24 PASS, sans échec
ni skip. Les autres jobs natifs non sélectionnés sont SKIP, pas PASS.
Le [reçu natif](research/2026-11-15/recovery-diagnostics/native-result.json)
conserve les identités, empreintes et limites.

La réussite de cette expérience ne qualifie pas à elle seule D2–D9.
Les preuves historiques gardent leurs propres SHA ; le matériel, le reboot
physique, le profil final, l'intégration financière et l'audit externe restent
des critères distincts. Aucun merge `main`/`dev`, déploiement ou activation.
