# PR #333 — corrections de révocation et anti-rejeu du 2 novembre 2026

## Identité et périmètre

- Dépôt : https://github.com/khemisset18/gpubnb
- PR : https://github.com/khemisset18/gpubnb/pull/333
- Branche exclusivement modifiée : `audit/stage4-consolidated-security-20261101-01`.
- Cible inchangée : `codex/stage4-private-console-gateway-20261030`.
- HEAD initial vérifié : `cc92f9aae33d81381d9f714eb338c4599233d631`, identique au SHA de la mission. Aucun nouveau commit à examiner au démarrage.
- Commit révocation vidéo : `abe5305b27743b6a8c61564a2a044ba80f6411ab`.
- Commit benchmark Prisma : `0e641b1c1176be31762aa70182555a03b8e923ed`.
- Commit anti-rejeu Helper : `4b38a0cda7acf527428c21d45b5ee23e1b5d9789`, suivi dans le commit contenant ce rapport de la correction du test Linux et du formatage Rust.
- Le commentaire de bilan de la PR donne le SHA final et les résultats réellement obtenus après publication de ce rapport. Les résultats des SHA précédents ne valident pas ce dernier commit.

Mission partiellement réalisée : les défauts logiciels bloquants énumérés plus bas ne sont pas déclarés résolus. Aucune fusion, revue APPROVED, demande de contre-audit, installation, interaction PC1/PC2, modification Supabase, Render, secret, certificat réel, réservation publique, paiement ou sortie de quarantaine.

## Modifications et preuves

Les lignes exactes sont accessibles dans le diff GitHub et le commentaire de bilan final ; les symboles ci-dessous identifient les frontières concernées sans dépendre du décalage des lignes entre commits.

| Fichier | Défaut initial et correction | Commit / test associé |
|---|---|---|
| `apps/api/src/workspace-gateway-channel-lease.ts` | `pending` partagé même avec cache nul ; un appel tardif héritait d'une ancienne lecture. Lectures indépendantes à cache nul, révision locale bloquant les anciens résultats après refus connu, invalidation terminale explicite. Le cache positif natif reste à zéro. | `abe5305…` ; suite native lease |
| `apps/api/src/workspace-gateway.ts` | La livraison vidéo ne vérifiait que l'existence du canal avant une autorisation potentiellement ancienne. `NATIVE_DELIVERY_FENCE_SCRIPT` compare liaison exacte et identité cookie exacte après la DB ; fermeture/invalidation locale et seconde vérification `browserClosed` pour l'entrée. | `abe5305…` ; vraie boucle pump avec E/S contrôlées + Lua sur Redis réel |
| `apps/api/test/workspace-native-revocation-lease.test.ts` | Anciennes assertions valorisant la coalescence remplacées par lectures indépendantes et barrières reproduisant ancienne réponse positive après nouveau refus ; invalidation vidéo/entrée. Aucun cas de rejet supprimé. | `abe5305…` |
| `apps/api/test/workspace-gateway-atomic-revocation.test.ts` | Test Redis réel supplémentaire du dernier fence : suppression cookie, remplacement identité cookie, remplacement liaison, suppression canal. Les tests Lua d'enqueue existants sont conservés. | `abe5305…` |
| `apps/api/test/workspace-native-delivery-race.test.ts` | Nouveau test exécutant le véritable callback upgrade et la véritable boucle pump : positif témoin, cookie révoqué, liaison remplacée, socket fermé pendant la lecture DB par frame. Socket et E/S contrôlés ; ce n'est pas un test vidéo physique. | `abe5305…` |
| `apps/api/test/windows-native-private-console-authorization.test.ts` | Assertions de câblage actualisées pour le fence exact après DB et le contrôle close après await ; tests comportementaux précédents en complément. | `abe5305…` |
| `apps/api/test/workspace-native-revocation-real-io.integration.test.ts` | Le proxy SELECT 1 est remplacé par la véritable `activeGatewaySession`, sur huit graphes relationnels natifs de test et Redis réel ; vrais comptages SQL Prisma, p50/p95/p99, CPU processus, RSS, cadence ; barrière avec STOP DB committé et expiration ; présent commit : dequeue réel PostgreSQL/Redis et rejet après révocation canal/cookie/STOP. | `0e641b1…` |
| `apps/api/test/fixtures/native-gateway-session.ts` | Fixture relationnelle isolée : propriétaires/locataires, machines, catalogue, annonces, réservations, allocations, jobs et sessions natives. Aucune session Windows lancée. | `0e641b1…` |
| `native/windows-stream-helper/src/service_runtime.rs` | Un reset du compteur de connexion pouvait réutiliser l'epoch courant. `begin_browser_connection` vérifie READY/capacité et frontière locataire, puis alloue un nouvel epoch ; saturation = refus/révocation. Allocateur partagé testable hors Windows dans le présent commit. | `4b38a0c…` et présent commit ; Rust reconnect et saturation |
| `native/windows-stream-helper/src/qualification_server.rs` | Les deux chemins interactifs allouent un epoch de connexion frais. Le chemin partagé réauthentifie le token courant sous le même mutex que la rotation, pour couvrir SUSPEND/RESUME entre la première authentification et l'admission. Aucun changement du format binaire. | `4b38a0c…` ; Rust + contrats navigateur/Agent |
| `native/windows-stream-helper/src/browser_input_protocol.rs` | Test négatif explicite : ancien premier paquet accepté si seul le compteur est réinitialisé ; refus après allocation du nouvel epoch ; séquence rejouée refusée. Allocateur portable, zéro et overflow refusés. | `4b38a0c…` et présent commit |
| `apps/api/src/workspace-gateway.ts` (file machine) | `next`/`next-batch` renvoyaient des commandes déjà en file sans renouveler leur autorité. Métadonnée interne de liaison exacte à l'enqueue ; réautorisation DB, cookie et fence exact au dequeue. Anciennes commandes natives sans liaison rejetées. Métadonnée retirée avant réponse Agent. Refus ultérieur d'une session dans un lot retire aussi ses positifs antérieurs ; `ws_close` reste transmis pour nettoyage. Délai maximal par validation : 5 s ; une réponse DB tardive ne peut changer un résultat déjà refusé. | Présent commit ; suite queued revocation |
| `apps/api/test/workspace-native-queued-revocation.test.ts` | Tests `ws_open` et `ws_send` : STOP DB, cookie/canal révoqué, remplacement liaison, renter/machine/backend modifiés, expiration, ancien élément sans fence, pannes, délais et barrières ; compatibilité container et nettoyage close. | Présent commit |
| `docs/security/stage4-pr333-20261102-follow-up.md` | Bilan, limites, trois passes contradictoires et protocole physique futur. | Présent commit |

## Garanties précises et limites atomiques

1. Le script Lua de chaque enqueue existant linéarise la comparaison Redis de la liaison et la publication dans Redis. Le dernier fence vidéo linéarise seulement une décision d'autorisation Redis ; il ne rend pas atomiques Redis et `ws.send`.
2. Au moment de ce dernier fence, une liaison différente ou un cookie supprimé/remplacé sont refusés. Une révocation **après** ce fence peut encore croiser l'envoi socket. Aucun octet déjà transmis à TCP n'est rappelé.
3. La révision du guard empêche une ancienne réponse positive de survivre à un refus **déjà observé par cette instance du guard**. Ce n'est ni une invalidation interprocessus ni une transaction PostgreSQL/Redis.
4. Le dequeue contrôle de nouveau les commandes encore dans la file API ; cela ne rappelle pas un lot déjà retourné à l'Agent. Une révocation DB après sa dernière lecture peut encore croiser Redis/HTTP/Agent. Les files Agent et les IPC Worker ont leurs contrôles locaux, pas une génération DB commune démontrée.
5. Le mutex Helper protège la réauthentification du token et la rotation d'epoch contre les transitions locales du runtime. Une nouvelle connexion ne reprend plus le compteur à 1 dans le même epoch. Ce compteur est limité à la vie du runtime ; ce n'est pas une génération distribuée globalement non réutilisable.
6. Les formats de média et d'entrée restent identiques. Le navigateur reconstruit déjà l'encodeur d'entrée lorsqu'il observe un nouvel epoch vidéo. Pas de modification Worker, clés ou certificats.
7. Les échecs DB/Redis et délais dans les validations ajoutées ne donnent pas d'autorisation. Le timeout de dequeue ignore une éventuelle réponse tardive ; il n'annule pas l'opération réseau sous-jacente.

Une frame locataire tardive et une fuite de pixels propriétaire sont deux propriétés différentes. Ces tests portent sur l'autorisation et le protocole ; ils ne prouvent pas l'identité des pixels d'une capture Windows physique.

## Tests et mesures

Les résultats locaux portent sur les arbres de source correspondants avant publication ; seul le commentaire final atteste les checks GitHub rattachés au SHA final exact.

| Test / environnement | SHA ou arbre testé | Résultat à la rédaction | Preuve / limite |
|---|---|---|---|
| Guard, pump, contrats natifs/API ciblés, Node 24 Linux local | Source API du présent commit | PASS : 245, FAIL : 0, NON EXÉCUTÉ : 12 intégrations sans services locaux | Pas de Redis/PostgreSQL local, pas de socket Windows |
| Révocation dequeue, Node Linux local | Source du présent commit | PASS : 27 | Doubles E/S et barrières ; pas une preuve réseau Agent |
| Navigateur natif, Node Linux local | Source de cette intervention | PASS : 94 | WebCodecs simulé, aucun flux NVENC matériel |
| Agent gateway, Python 3.12 venv isolé | Source inchangée Agent | PASS : 129 | Pas de service Windows démarré |
| Agent Windows native, Python 3.12 venv isolé | Source inchangée Agent | PASS : 160 | Contrats et doubles ; pas d'isolation physique |
| TypeScript noEmit et Prisma generate | Source API de cette intervention | PASS | Vérification de compilation locale ; tests finaux GitHub à consulter |
| Suite API CI avec Redis/PostgreSQL réels | `0e641b1c1176be31762aa70182555a03b8e923ed` | PASS : 879, FAIL : 0, NON EXÉCUTÉ : 2 | https://github.com/khemisset18/gpubnb/actions/runs/41366580417/job/125027938220 ; fence Redis et vraie requête Prisma effectivement exécutés |
| Nouveau test Rust, Windows CI | `4b38a0cda7acf527428c21d45b5ee23e1b5d9789` | Tests Rust et Clippy PASS ; job FAIL sur rustfmt | https://github.com/khemisset18/gpubnb/actions/runs/41366882983/job/125028803953 ; formatage corrigé dans le présent commit, revalidation nécessaire |
| Nouveau test Rust, Ubuntu CI | `4b38a0cda7acf527428c21d45b5ee23e1b5d9789` | FAIL : test référençait un module Windows | https://github.com/khemisset18/gpubnb/actions/runs/41366882983/job/125028803976 ; allocateur déplacé dans le module portable, test conservé |
| Rust, PowerShell 5.1/7 local | Environnement Linux sans cargo ni PowerShell | NON EXÉCUTÉ | Les workflows Windows existants exécutent les validations ; pas de substitution par Python |
| Nouveau package 4/4 signé au SHA final | Aucun | NON EXÉCUTÉ | Aucun certificat réel utilisé, aucun package installable attesté |
| Recovery après kill indépendant / power-loss | Aucun | NON EXÉCUTÉ | Mécanisme recovery durable non implémenté ; les rollbacks sur exception ne suffisent pas |
| Qualification PC1 → PC2 | Aucun | NON EXÉCUTÉ | Interdite dans cette mission |

Mesures historiques **de ce job CI seulement**, sur `0e641b1…` :

| FPS | Canaux | Autorisations | Requêtes SQL | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|
| 30 | 1 | 30 | 90 | 3,01 | 5,29 | 6,64 |
| 30 | 4 | 120 | 360 | 3,94 | 6,88 | 25,62 |
| 30 | 8 | 240 | 720 | 4,77 | 6,74 | 9,30 |
| 60 | 1 | 60 | 180 | 2,35 | 2,93 | 6,11 |
| 60 | 4 | 240 | 720 | 3,13 | 4,22 | 4,50 |
| 60 | 8 | 480 | 1440 | 4,56 | 6,70 | 8,82 |

Le test compte 3 SQL par autorisation avec cette version de Prisma et ce schéma. Il mesure aussi CPU du processus Node et RSS, pas CPU du serveur PostgreSQL. À 60 FPS × 8 : environ 1,01 s CPU utilisateur, 0,118 s système et RSS finale ~166 Mo dans ce job. Huit graphes relationnels de test, une seconde par configuration, ne constituent pas une population de production ni une étude prolongée de saturation.

**Exclus de ces chiffres :** capture/encodage/décodage, payload vidéo, dernier fence Redis de livraison, accounting des queues, chemin input complet, reconnexions prolongées, saturation, pertes de services réelles, CPU Redis/PostgreSQL et réseau Render. Les benchmarks synthétiques restent distincts de cette intégration réelle ; aucun ne remplace le streaming matériel. La réautorisation dequeue augmente les lectures par commande (également pour les anciens relays container non marqués) : impact de débit à mesurer, pas de cache positif ajouté pour le masquer.

## Trois passes contradictoires internes

### A — Sécurité offensive

- Tentative de récupération d'un ancien positif après refus : couverte par barrières du guard ; refus attendu.
- Cookie simplement présent mais identité remplacée : le dernier Lua vérifie la valeur exacte, test Redis réel.
- Réutilisation d'un ID de canal avec une autre liaison : comparaison exacte vidéo, enqueue et dequeue ; tests négatifs.
- Rejeu du premier événement après reconnexion sans suspend : contrôle régressif démontre l'acceptation si l'epoch est réutilisé ; nouvel allocateur et fence le refusent.
- **P0 restant :** génération commune DB/API/Agent/Helper/Worker/browser absente ; la rotation locale d'epoch n'en est pas un substitut.
- Lecture Windows : `session.rs` valide WTS/identités, Worker contrôle après capture et avant injection, Helper maintient le verrou pendant la publication. Ces barrières existantes sont conservées. Absence de fuite physique propriétaire NON DÉMONTRÉE.

### B — Concurrence et résilience

- Cookie supprimé et liaison remplacée pendant DB : la vraie boucle pump refuse l'envoi ; témoin positif conservé.
- Close pendant DB : guard invalidé et contrôle local avant send ; entrée vérifiée aussi après await.
- Commande en file après STOP : nouveau dequeue refuse ; metadata interne jamais livrée à l'Agent.
- **P0 restant :** révocation DB après dernière lecture, lot déjà retourné à l'Agent, commandes IPC déjà en transit ; pas de transaction commune ni de point global de linéarisation.
- **P1 restant :** `activateGatewaySession` s'exécute toujours avant l'enqueue des deux endpoints Agent. Une première frame refusée pour révocation/backpressure peut activer le temps commercial. Déplacer l'appel seul ne résout pas les pannes croisées : il faut un protocole durable d'acceptation/activation et ses compensations.
- **P1 restant :** aucun journal de maintenance durable ni reprise indépendante après interruption ; les `.stage4-*` bloquent une autre tentative mais ne restaurent pas automatiquement un état cohérent.

### C — Exploitation et release

- SHA40/Authenticode/ACL/rollback : aucune exigence affaiblie et aucun script de maintenance modifié. Cela ne constitue pas un nouvel audit exhaustif de la chaîne de release.
- Le nouvel epoch reste dans le même format u64 ; overflow et zéro refusés ; il ne prouve pas l'unicité au-delà de la vie du runtime.
- **P1 restant :** la santé post-maintenance utilise encore les observations locales PID/hash/signature/heartbeat. Pas de preuve serveur fraîche liée au processus exact et acceptée avec nonce/boot ID.
- **P1 restant :** récupération des touches/boutons maintenus après perte de connexion non démontrée par cette intervention. La rotation d'epoch bloque les replays ; elle ne relâche pas les touches.
- **P1 restant :** aucun paquet 4/4 signé au HEAD final ; pas de test physique de substitution entre vérification et utilisation.
- **P2 restant :** tests de charge longs, saturation, profiling serveurs et queue/input complets à produire. Le p99 25,62 ms à 30 FPS/4 canaux interdit de transformer ces petits échantillons en garantie SLO.

Ces trois passes sont internes et ne valent pas revue indépendante.

## Recovery Windows et attestation : état bloquant

Le moteur actuel calcule GUID, sauvegardes/hash/SDDL et rollback d'exception. Il ne persiste pas les états PREPARED/STOPPED/REPLACING/VERIFYING/COMMITTED/ROLLING_BACK/RECOVERY_REQUIRED dans un journal récupérable par un nouveau processus. Aucun correctif recovery complet n'est livré ici : c'est un défaut logiciel restant, pas seulement un test matériel manquant.

Le futur recovery doit utiliser un journal protégé lié aux quatre identités, vérifier originaux et sauvegardes avant tout arrêt, garder le runtime arrêté tant que l'ensemble n'est pas qualifié, traiter des renommages interrompus et rollback interrompu, refuser un journal altéré et attester réellement l'ancien runtime après restauration. Les états et actions devront être idempotents après kill indépendant à chaque frontière demandée, puis testés en VM Windows isolée. Un journal JSON et des renommages seuls ne suffisent pas à annoncer une garantie power-loss.

Références Windows officielles à examiner pour cette implémentation : [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw), [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers), [File caching](https://learn.microsoft.com/en-us/windows/win32/fileio/file-caching). La garantie de flush d'un appel ne rend pas atomiques quatre remplacements et ne remplace pas les essais d'arrêt brutal/coupure et la validation du support de stockage.

L'attestation distante doit partir du modèle de confiance existant de la clé machine Agent et d'un challenge serveur à usage unique lié au boot/process/hash/SHA40/protocoles/identité machine. Une signature produite par une clé machine ne prouve pas, à elle seule, quel processus l'a utilisée : définir le détenteur de clé et le contrôle local du processus avant d'annoncer cette propriété. Aucun secret/certificat réel créé ou modifié.

## Protocole physique futur — ne pas exécuter

Préconditions cumulatives : corriger les blocages logiciels ci-dessus, obtenir tous les résultats sur le HEAD exact, revue indépendante, paquet 4/4 signé correspondant, recovery qualifié et autorisation physique distincte. Les actions ci-dessous sont un protocole futur, pas une autorisation actuelle.

1. Sur environnement Windows de qualification autorisé, consigner machine, GPU UUID/LUID, SHA40 des quatre composants, hashes, signatures, SDDL, protocoles, Windows build, SID propriétaire et SID locataire distincts, WTS ID et identité de chaque processus. Conserver quarantaine et accès privé.
2. Placer des marqueurs visuels inoffensifs distincts sur bureaux locataire/propriétaire. Contrôler exclusivement la session locataire. Instrumenter WTS/SID/bureau de capture ; tout pixel propriétaire ou ambiguïté impose STOP et abandon, jamais un fallback.
3. Après autorisation séparée du streaming, décoder 300 secondes sur PC2 ; conserver compteurs de frames, timestamps, epochs, pertes, latences, mémoire et erreurs. Vérifier les pixels/dimensions réellement décodés, pas seulement les octets réseau.
4. Observer clavier et souris sur une application locataire de test. Tester down/up, boutons maintenus, déconnexion brutale, événements tardifs, ancien epoch, séquences répétées. Vérifier relâchement effectif sans jamais injecter sur le bureau propriétaire.
5. Déclencher STOP, SUSPEND/RESUME, révocation DB, suppression cookie/canal et pannes réseau/Redis/PostgreSQL dans le laboratoire autorisé. Corréler instants d'autorité et derniers octets/frames/inputs ; distinguer publications avant révocation, octets TCP déjà en vol et opérations nouvelles refusées.
6. Tester reconnect avant/après suspend, lock/unlock, Fast User Switching, changement WTS, logoff locataire, écran/topologie/GPU modifiés. Chaque ambiguïté doit couper capture et input ; aucune bascule automatique vers le bureau propriétaire.
7. Après STOP, démontrer arrêt Worker/Helper/session, absence de ressources/touches/boutons/fichiers temporaires non réconciliés, suppression des canaux et refus des anciens messages. Les preuves de sortie de quarantaine seront examinées séparément ; ne pas lever la quarantaine dans cet essai sans autorisation spécifique.
8. Archiver preuves horodatées, journaux expurgés, SHA exacts et causes d'arrêt. Un rollback/restauration doit repasser les vérifications d'intégrité et de santé ; tout échec maintient NO-GO.

## Décision

CORRECTIONS ENCORE NÉCESSAIRES
