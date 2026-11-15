# DOGE — stabilisation du 15 novembre 2026

Qualification complète **BLOCKED**. Aucun nouveau résultat natif n'est déclaré.

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

## Exécution native encore nécessaire

Le connecteur permet lecture et publication de code, mais n'expose pas le
lancement d'un nouveau workflow. La CLI GitHub et le navigateur de cette session
ne sont pas authentifiés. Aucun contournement du routage manuel n'est ajouté.

Après authentification, lancer l'entrée existante `workspace-reliability`,
branche exacte `asset-exchange/doge-recovery-consistency-20261112`, choix
`recovery-consistency`, avec le harnais correspondant au nouveau code.
Vérifier les deux cas natifs, les quatre étapes watcher, l'absence de clés et
de nouvelles signatures, zéro diffusion pendant le refus, puis les octets
identiques et les confirmations après restauration. Deux blocs maximum,
400 RPC et huit invocations autonomes restent les plafonds existants.

La réussite future de cette expérience ne qualifiera pas à elle seule D2–D9.
Les preuves historiques gardent leurs propres SHA ; le matériel, le reboot
physique, le profil final, l'intégration financière et l'audit externe restent
des critères distincts. Aucun merge `main`/`dev`, déploiement ou activation.
