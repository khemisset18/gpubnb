# Stage 4 — reprise sur preuves, 28 octobre 2026

**Qualification physique BLOQUÉE. Promotion BLOQUÉE.** Base de cette branche :
`40e9ef5991ab13753130121fd321c60c84b4a297`, PR #307 fusionnée dans
`qualification/stage3-windows-native-private-3c3e21e6`. L'étude RDP n'est pas la base.
Le commit contenant ce document constitue la proposition source ; aucun paquet
binaire correspondant à cette nouvelle proposition n'est attesté ici.

## Preuves relues, sans refaire les diagnostics PC1

- [PR #307](https://github.com/khemisset18/gpubnb/pull/307) et
  [correction PC1](https://github.com/khemisset18/gpubnb/pull/307#issuecomment-6450709341).
- Les 15 résultats Actions au commit de base ont été consultés via GitHub : tous
  terminés avec `success`. Aucun ancien workflow n'a été relancé.
- Certificat du 21 septembre expiré ; certificat du 18 octobre : `/pa` réussi,
  `/kp` refusé, racine non approuvée. Aucun nouveau certificat ni nouvelle signature.
- `oem176.inf` installé, export réussi ; nouveaux composants non déployés.
  Les anciens Worker/Helper signés de b167d2c ne prouvent pas le code de #307.
- Génération 90 toujours en quarantaine. Les trois échantillons QUIET et la sortie
  normale d'Avast suivie d'un inventaire NVIDIA sans client sont des observations,
  pas des preuves de STOP/absence de moniteur ni une autorisation de récupération.
- Aucun accès shell/bureau PC1/PC2. Aucun exécutable Windows lancé, aucun self-test,
  changement Render, installation, signature, réservation ou test physique.

## Chemin exact de `virtual_display`

1. `native/windows-idd/Driver.cpp` valide l'ABI et la requête. Le verrou de
   compilation peut retourner `STATUS_NOT_SUPPORTED`; l'état de l'adaptateur,
   l'identité et l'exclusivité ont leurs propres refus. Le gate est activé par
   `GPUBNB_PHYSICAL_QUALIFICATION_BUILD` ou `GPUBNB_RELEASE_CANDIDATE_BUILD`, pas par
   le seul statut PnP OK.
2. `native/windows-platform/src/idd_control.rs` découvre l'interface, ouvre le
   contrôle puis effectue l'IOCTL. Les classes distinguent requête d'interface,
   absence, ambiguïté, ouverture, contrôle, accès, busy, not-ready et requête invalide.
   L'erreur Win32 50 de contrôle est classée `IddUnsafeOperation`.
3. `native/windows-stream-helper/src/service_runtime.rs`,
   `classify_virtual_display_failure`, transforme ces classes en codes publics
   `virtual_display_*`. Le cas de repli `_` reste `virtual_display` même avec le
   code actuel : un message générique ne prouve donc pas un vieux Helper.
   L'activation du moniteur appartient au Helper ; le Worker intervient dans la
   session, les preuves graphiques, la capture/média et les entrées après cette
   frontière. Il n'est pas l'émetteur de ces sous-codes IddCx.
4. `authority.rs` conserve les codes bornés dans `RuntimeFailure`, y compris via
   la réponse IPC START ; `main.rs` imprime `{"ok":false,"error":"..."}` sans
   diagnostics bruts. Les échecs de nettoyage restent prioritaires.
5. Le préflight Python conservait déjà les sous-codes. En revanche,
   `launch_windows_native_workspace` écrasait tout retour START non nul en
   `native_workspace_start_failed`. L'allowlist des autres commandes omettait
   aussi tous les sous-codes IddCx. **Corrigé dans cette branche** : vocabulaire
   IddCx partagé, START et cycle de vie conservent la cause bornée. START exige
   toujours STOP ; si STOP ne prouve pas le nettoyage, `_cleanup_unverified`
   reste le suffixe final et le gateway conserve son blocage.
6. `workspace_gateway_v10.py` conserve le code via `_native_error_code` (120
   caractères max), le trace puis le préfixe pour le callback. `cli.py` et
   `recovery_runtime.py` émettent `workspace_gateway_error` (300 caractères max).
   Les nouveaux codes restent dans ces bornes. Les tests couvrent les 11 classes,
   STOP confirmé/non confirmé, les quatre verbes de cycle de vie, le JSON ambigu
   et les erreurs non autorisées. Aucun stderr n'est repris.
7. Le collecteur existant `stage4-pc1-incident-evidence.ps1` est corrigé pour
   conserver aussi le suffixe `_cleanup_unverified` ; auparavant sa frontière de
   mot faisait disparaître le sous-code dans ce cas. Il reste en lecture seule,
   sans exécution de composant, avec codes autorisés uniquement.

**Limite API explicite :** `platform_info.windows_native_desktop_streaming_capability`
renvoie disponibilité/UUID, pas `snapshot.reason`. Le schéma heartbeat et
`apps/api/src/windows-native-capability.ts` valident cette capacité, pas une cause
IddCx. Le callback d'erreur émet un événement Agent ; ce chemin n'est pas un
rapport détaillé persisté par l'API. Le refus API de disponibilité ou une erreur
terminale de nettoyage ne permet pas de reconstituer une cause START.
Cette correction n'ajoute pas de schéma de télémétrie ni de migration API et ne
prétend pas avoir établi une conservation jusqu'à un champ API inexistant.

Pour attribuer l'incident historique, il manque la correspondance vérifiable
entre les SHA-256/source/build flags des **Agent et Helper effectivement exécutés**,
le DLL/CAT/INF effectivement chargés (`GPUbnbIdd.dll` d'oem176), et le rapport JSON
ou journal borné contemporain de l'échec. Une version INF, un nom de certificat,
un build récent non installé ou un test ultérieur ne rétablit pas cette preuve.
Ne pas relancer `--self-test` pour la fabriquer. L'absence de cette attribution
historique n'oblige pas à abandonner IddCx et n'est pas, seule, un verrou au futur
package correctement qualifié.

## Paquet de base vérifié hors ligne

L'[artefact 12737519266](https://github.com/khemisset18/gpubnb/actions/runs/40513525078)
a été téléchargé, extrait et vérifié avec `verify_stage4_package.py` sans exécuter
ses binaires. L'empreinte de l'enveloppe Actions correspond à la métadonnée GitHub.

| Objet | SHA-256 |
| --- | --- |
| Archive Actions | `d5b57c498ea9c884e7f29cc93a1ab9773608fa1406770892e29eba446ff85854` |
| ZIP interne | `0054a79e706109a9b32e7fba013b8b56fc9bf842cb4404ad03a9093077759065` |
| Manifeste | `545c794c4ed7de0e5963da016e964b3d0e92fcb23f343269c96245cf8f876b2b` |
| Agent | `09557ef6939bcde0bf0482bb5b0e6f3b8a02e1797384cceeaca27e244590a666` |
| Helper | `c004f3ce3e818be6dcc4d9fde7bb7e6b44e8772398dfa7a5e4dedb0303012a4b` |
| Worker | `da98aee4f3a2923ec792064f9ddb8403dc100014e3fd63e22b6b3c117a9bae9e` |
| DLL média | `1fd2ca37e24f882e230d812e6e1f521b8272fb7dc532f69d4cb5c6aab101b9a6` |

Identités liées par le manifeste : Agent 0.6.6 / commit abrégé `40e9ef5991ab`,
Helper/Worker/média au SHA complet de base ; autorité Helper `release-candidate` ;
protocoles Worker 1, transport 2, navigateur média/entrée 1, ABI média 2 ; NVENC
API 13.0, headers épinglés à `e844e5b26f46bb77479f063029595293aa8f812d`.
Les quatre PE AMD64, imports et empreintes passent la vérification hors ligne.
Ce sont les identités capturées par CI, pas une nouvelle exécution Windows locale.

Le pin embarqué et déclaré est
`88662fb76d4237aa3842ad1ad8d0378a17ffb82d022f860b297ed85e2c08c99a`.
Les quatre fichiers sont **non signés** : ce pin n'est pas l'identité d'un
signataire observé. D'autres scripts de test ont encore un pin par défaut
`200208e0ef9dc3de4911df5541e6b11506c07de2820849006311cb68b342965a` ; ce n'est pas une
preuve de correspondance. Aucun pin n'a été modifié. Les paramètres explicites
et la correspondance avec le certificat réellement autorisé restent obligatoires.

| Élément de la future version cohérente | Décision de promotion |
| --- | --- |
| API | Source présente ; révision réellement déployée non vérifiée ici. Aucun accès Render effectué. |
| Agent, Helper, Worker, média | Paquet de base cohérent mais non signé et antérieur à cette correction ; nouveau build au même SHA complet requis. |
| Pilote IddCx | Absent de l'artefact ; aucun payload final accepté avec source/build flags/ABI vérifiables. BLOQUÉ. |
| Ensemble des six | Aucun manifeste/provenance complet reliant API déployée, quatre composants et pilote accepté. BLOQUÉ. |

Les indicateurs `installable=false`, `iddDriverIncluded=false` et
`publicBookabilityEnabled=false` restent inchangés. Un succès du vérificateur
quatre composants n'autorise jamais la promotion de l'ensemble des six.
Pour une future promotion, attacher au SHA source final les empreintes finales
après signature, identités de signataires/chaînes, provenance CI, configuration de
compilation du pilote, compatibilité ABI et preuve de déploiement API. Toute
entrée sans provenance vérifiable reste bloquante ; ne pas mélanger b167d2c,
40e9ef, la branche RDP et cette proposition.

## Windows 11, PnP, rollback et coût

La voie officiellement documentée à étudier est la signature Microsoft via le
Hardware Developer Program : attestation pour test Desktop, ou HLK/WHCP pour
certification. L'attestation prend en charge les pilotes utilisateur ; IddCx est
UMDF. Une affirmation générique sur les pilotes noyau ne suffit donc pas à prouver
sa charge réelle. L'acceptation du package cible, du catalogue et de ses membres,
de la politique effective et de l'ABI reste nécessaire. `/pa` seul ne remplace
pas les contrôles requis, et l'échec `/kp` déjà établi ne devient pas un succès.

Les sources officielles exigent un compte avec certificat EV ; aucun accès à
ces moyens n'est démontré. **Aucune voie gratuite nouvelle n'est validée à 0 €.**
Dépense engagée par ce travail : 0 €. Ne pas proposer d'achat, de nouvelle
signature ni promettre un coût nul de certification. La signature préproduction
exige un provisionnement de confiance : hors limites ici. Secure Boot, HVCI,
intégrité du code, magasins de confiance et pins restent inchangés.

PnP connu : oem176, 2026-09-28 / 9.3.32.4, rang 00FF0000 ; oem175, 2026-09-23 /
6.36.27.148 au même rang, supplanté. Le candidat source 2026-09-18 / 0.1.0.0 perd
à rang égal. Un futur package signé peut avoir un autre rang : le mesurer, ne pas
le prédire ni gonfler arbitrairement la version. Ne pas éditer un INF signé ni
forcer un downgrade. Export oem176 réussi ne signifie pas rollback chargeable :
conserver l'export, contrôler CAT/INF/DLL et leur appartenance, leurs hashes et
leur acceptation avant toute future installation autorisée. Aucun rollback exécuté.

Sources officielles consultées le 28 octobre 2026 :
- [Options de signature](https://learn.microsoft.com/windows-hardware/drivers/dashboard/driver-signing-offerings)
- [Attestation](https://learn.microsoft.com/windows-hardware/drivers/dashboard/code-signing-attestation)
- [Exigences EV](https://learn.microsoft.com/en-gb/windows-hardware/drivers/dashboard/code-signing-reqs)
- [Rang, date et version PnP](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/overview-of-the-driver-selection-process)

## Récupération : protocole conservé, jamais déclenché ici

Revue de `windows_native_quarantine_recovery.py`, `windows-native-quarantine-recovery.ts`
et du contrat signé de #307 : DiagnosticRun frais OWNER/ADMIN ; requête v2 signée
liée au corps ; identité machine/session/GPU/ressource exacte ; session terminale ;
aucune allocation, session active, activité mining ou lease ; fence Redis durable
non perdu/non régressé. Les tests HTTP/Postgres/Redis réussis de #307 demeurent la
preuve d'intégration consultée, pas un nouveau test de production.

Le verrou physique couvre préparation, diagnostic Docker/GPU et soumission. STOP
et AssertNoMonitor puis quiescence canonique sont prouvés avant et après le
diagnostic ; autorité et état local sont revérifiés. Le tombstone STOPPED conserve
le plancher autorisé avant `release_after_cleanup`. Aucun reset de génération,
aucune suppression manuelle, aucune exception pour client GPU tiers. Preuve
Docker seule, scope ambigu, identité de processus présente ou fence changé : refus.
Les modifications de diagnostic de cette branche ne changent aucune de ces règles.

## Plan PC1 → PC2, seulement après levée des prérequis et autorisation physique

1. Valider le paquet complet au SHA final, la politique Windows existante, le rang
   et le rollback. Une future installation nécessite une autorisation distincte.
2. Récupérer génération 90 par le DiagnosticRun signé existant, avec les preuves
   répétées ci-dessus. Garder l'offre privée non réservable pendant la qualification.
   Aucun START ne doit contourner cette étape ; QUIET seul ne suffit pas.
3. Préparer le test privé sans coût ni réservation payante : session locataire
   dédiée, identité/lease/GPU exacts, moniteur IddCx isolé lié au nonce, sortie
   fournisseur exclue. Relais authentifié GBNM/GBNI existant, droits bornés.
4. Prouver la capture de cet écran sur le GPU NVIDIA exact, l'encodeur réellement
   NVENC H.264 et le décodage navigateur PC2. Ni drapeau, ni codec annoncé, ni
   timer, ni image figée ne suffit. Refuser tout fallback logiciel.
5. Enregistrer 300 secondes continues d'images décodées qui avancent, avec le
   seuil de trou existant de 3 secondes. Montrer séparément les effets visibles
   du clavier et de la souris dans la session isolée.
6. Prouver reconnexion avec les mêmes contrôles de scope/génération, puis STOP.
   Si une rupture invalide la continuité, recommencer la fenêtre de 300 secondes.
7. Vérifier disparition Helper/Worker et libération moniteur, capture, encodeur,
   entrée, écouteur, claims/leases locaux et serveur, et quiescence GPU. Conserver
   les preuves signées et le tombstone. Tout échec maintient les blocages.

L'[étude RDP](https://github.com/khemisset18/gpubnb/blob/codex/stage4-rdp-feasibility/docs/architecture/WINDOWS_NATIVE_RDP_ALTERNATIVE_FEASIBILITY_20261028.md)
reste séparée : client/protocole/gateway différents, isolation console à prouver,
NVENC réel non déduit d'une politique pouvant retomber en logiciel, coût nul non
établi. Aucune nécessité démontrée de remplacer l'architecture Native ; aucun
succès RDP ne qualifie IddCx/GBNM/GBNI.

## Validation exécutée sur l'environnement de développement Linux

- `test_windows_native_runtime.py` : 44 tests PASS, dont trois nouvelles méthodes
  paramétrées couvrant causes, nettoyage et rapports non fiables.
- `test_windows_native_workspace.py` : 22 tests PASS.
- `test_windows_native_quarantine_recovery.py` : 20 tests PASS, pour contrôler
  l'absence de régression à la frontière STOP modifiée ; commandes hôte simulées.
- Vérificateur hors ligne sur l'artefact réel #307 : 4/4 PASS,
  `authenticodeVerified=false`, `hardwareQualified=false`.
- `git diff --check` : PASS.
- Le premier import des tests a échoué faute de `websocket-client`; les dépendances
  de l'Agent ont été installées dans un venv isolé puis les tests ont réussi.
- Fixture PowerShell ajoutée pour le collecteur ; PowerShell absent localement,
  exécution Windows 5.1/7 à vérifier dans la CI de la proposition. Aucun résultat
  Windows de cette branche n'est déduit du succès Windows de #307.

## Seuls blocages indispensables au test physique

1. Ensemble API/Agent/Helper/Worker/média/pilote cohérent, signatures acceptables
   sous politique inchangée, provenance et pins vérifiés, rang/rollback établis.
   Il n'existe pas encore de candidat complet promotable ni de voie nouvelle
   officiellement chiffrée à 0 € pour obtenir la signature manquante.
2. Déploiement autorisé de cet ensemble puis récupération signée et vérifiable
   de génération 90. Ni l'un ni l'autre n'est autorisé ou réalisé dans cette tâche.
3. Autorisation explicite et opérateur/accès PC1–PC2 pour la campagne physique
   privée à coût nul. Les preuves physiques d'acceptation restent à produire.

Prochaine action : établir la provenance d'un package IddCx déjà signé et accepté
sous la politique Windows inchangée, disponible sans nouveau coût. Aucune commande
PC1 supplémentaire ne résout actuellement ce verrou de fourniture/signature.
