# Plan de migration Rust — contraintes vérifiées, migration non exécutée

État : **BLOQUÉ** pour correction complète. Les upgrades compatibles PyNaCl et
Rustls sont validés séparément ; aucune modification Anchor/Solana/GTK n'est
appliquée. Une suppression du graphe optionnel du scan ne serait pas un fix.

Le snapshot officiel Cargo dans RUST_CONSTRAINT_SNAPSHOT.json et le graphe
inverse exact conservé dans audits/evidence/security-followup-20261029 montrent :

| Blocage | Contrat sélectionné | Correctif hors contrat | Expérience vérifiée / conclusion |
| --- | --- | --- | --- |
| borsh 0.10.4 | Anchor 0.31.1 exige ^0.10.3 ; plusieurs crates Solana 2.x en dépendent | plage corrigée 1.x | Index officiel : aucun 0.10.5 publié ; dernier Anchor 1.2.2 exige ^1.5.7. Ce serait une migration majeure, pas un changement de lock compatible |
| rand 0.7.3 | libsecp256k1 0.6.0 exige ^0.7 | branches corrigées 0.8.6/0.9.3/0.10.1 | Aucun 0.7.4 publié ; libsecp256k1 0.7.2 exige ^0.8, mais le parent Solana doit accepter ce changement |
| glib 0.18.5 | gtk/atk/gio/pango/webkit2gtk actuels exigent 0.18 | glib >=0.20 selon l'avis | Aucun 0.18.6 publié ; gtk 0.19 exige glib ^0.22, mais Tauri 2.12.5, Wry 0.57.1 et WebKit2GTK 2.0.2 exigent encore GTK/GLib 0.18 |

Les versions « dernières » sont un constat au 29 octobre 2026, pas une
recommandation automatique de migration. Mettre Tauri à jour seul ne démontre
pas la suppression du graphe vulnérable. Forcer deux versions incompatibles de
GLib peut laisser l'ancienne en place et casser les types/FFI.

## Prototype de contrat, à autoriser séparément

1. Créer un worktree isolé pour Anchor/Solana. Figer un candidat complet du
graphe, ses licences et son MSRV. Faire résoudre Cargo normalement, sans changer
manuellement versions/checksums. Comparer l'ensemble des dépendances pour
borsh et rand, pas une seule occurrence.
2. Construire les IDL/ABI et comparer discriminants, tailles/layouts de comptes,
bytes de sérialisation, messages et signatures avec des vecteurs de référence.
Compiler le programme et les clients concernés. Exécuter les 7 tests actuels
plus tests de compatibilité de comptes/erreurs et limites arithmétiques. Une
modification financière/layout inattendue bloque ; aucune migration on-chain.
3. Dans un autre prototype desktop, suivre le correctif GLib amont et les
contraintes conjointes GTK/WebKit/Tauri. S'il n'existe pas de release coordonnée,
préparer un backport source minimal revu, avec commit de provenance explicite et
reconstruction/tests FFI sur Linux et Windows. Aucun fork ni exemption n'est
introduit par ce document.
4. Tester événements UI/native, ownership/lifetimes FFI, logs d'erreurs,
accessibilité et packaging sur plateformes réellement supportées. Une simple
compilation sans la feature desktop-runtime ne valide pas le graphe GTK.
5. Relancer Trivy intégral (dev inclus) sur le tree modifié et vérifier l'absence
des trois occurrences. Un backport sur la version encore signalée ne devient
pas PASS par ajout d'un ignore ; il faut résoudre avec l'outil/politique de
sécurité appropriée et une revue explicite.

Les contraintes et versions ci-dessus sont effectivement vérifiées. Les builds
et comparaisons de migration majeure ne sont **pas exécutés**. Ce plan n'est
pas décrit comme une migration testée ; il définit les tests manquants et les
risques exacts nécessaires à une demande d'extension de périmètre. Toute
modification Core financier/desktop dépassant les correctifs déjà autorisés
requiert un accord distinct sur ce prototype, sans merge ni déploiement.
