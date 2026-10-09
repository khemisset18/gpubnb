# GPUbnb Stage 4 — rapport de préparation technique du 9 octobre 2026

Décision : **GO préparation**, **NO-GO signature**, **NO-GO déploiement**, **validation physique non démontrée**. Ce dossier prépare un candidat ; il ne constitue aucune autorisation d'exécution. Aucun fichier n'a été signé, aucun accès nouveau à PC1 n'a été réalisé, aucun service n'a été redémarré, aucun déploiement ou fusion n'a eu lieu. Les observations PC1 proviennent exclusivement des sorties déjà fournies par l'utilisateur.

## 1. Versions et preuves GitHub

Dépôt : https://github.com/khemisset18/gpubnb. PR #285 ouverte, brouillon et non fusionnée ; HEAD `fe0b1cde539abb71e289e1875b0cc9dc32f1629d`. Le correctif du vérificateur correspond au commit `f797af6378928bdcc09e0f3494a57f16aa994d98`, branche `fix/authenticode-verifier-fail-closed-20261009`.

### Contrôles des commits demandés

| Commit | Workflow | Run | Conclusion vérifiée |
|---|---|---:|---|
| fe0b1cde | CI (PR) | 37978709771 | success |
| fe0b1cde | windows-native-stream-helper | 37978709636 | success |
| fe0b1cde | workspace-reliability | 37978709862 | success |
| fe0b1cde | prephysical-qualification (PR) | 37978709857 | success |
| fe0b1cde | deployment-readiness | 37978709924 | success |
| fe0b1cde | code-security | 37978709847 | success |
| fe0b1cde | api-mining-ci | 37978709821 | success |
| fe0b1cde | CI (push antérieur) | 37978705469 | success |
| fe0b1cde | prephysical-qualification (push antérieur) | 37978705448 | success |
| fe0b1cde | CI (push ultérieur) | 37988563153 | cancelled, pas un succès ni un défaut de test |
| fe0b1cde | prephysical-qualification (push ultérieur) | 37988563163 | success |
| f797af63 | Authenticode verifier tests | 37989110108 | success |
| f797af63 | prephysical-qualification | 37989110244 | success |
| f797af63 | CI | 37989110185 | success |

Preuve de chaque run : `https://github.com/khemisset18/gpubnb/actions/runs/<Run>`. Les noms « deployment-readiness » et « prephysical » désignent des contrôles automatisés ; ils ne prouvent aucun déploiement ni aucune stabilité physique. Les jobs Windows Authenticode `114018437032` (Windows PowerShell 5.1) et `114018437080` (PowerShell 7) annoncent chacun 34 vérifications réussies. Les anciens essais rouges de mise au point ne remplacent pas l'état final du commit.

Le job Windows helper `113983452353` réussit : 104 tests bibliothèque, 10 CLI et 3 intégration du helper, 58 tests plateforme, 11 worker et 1 harness de qualification ; les quatre régressions socket sont vertes. L'exécution sans lease échoue volontairement avec le code 21 : protection attendue, pas test contourné. Le job Ubuntu `113983452645` réussit également.

### Comparaison et candidat privé séparé

Le diff **fe0b1cde → f797af63 comporte exactement trois fichiers**, exclusivement le vérificateur Authenticode, ses tests et son workflow. Le helper Rust et le gateway ne changent pas. Il n'existe donc pas de divergence runtime introduite par le correctif PowerShell.

Le service de qualification Render observé utilise encore `6b655614d3b9c3fda7912742b539601ba22598f1`, déploiement `dep-db4j8gom7kps73c1u4p0`, service `srv-dau86i2d0e5s73elmk10` / `gpubnb-stage3-private`. Auto-deploy et previews désactivés. Son nom « private » indique l'usage de qualification ; c'est un web service HTTPS, pas un service exclusivement accessible sur le réseau privé Render. Aucune configuration réseau n'a été modifiée.

Déployer toute la branche f797af63 sur ce service introduirait aussi une migration et des changements du client Web. Pour rendre le candidat concret et limiter les incompatibilités, une branche dédiée a été créée depuis la version réellement observée : `prep/stage4-private-gateway-audit-20261009`.

| Commit remote | Changement |
|---|---|
| f792af7f18069ebafae0d95273aa12d6c362e35f | correctif gateway ws@7 et test réel WebSocket, sans changer migrations/client |
| c03d0118b0eaa9286fbc118b3cf1d409c93afebb | dépendances corrigées et nettoyage Agent différé conservateur |
| 985d616aafd4074810ba594759188e57487d9342 | seulement images officielles des services de test CI via leur miroir ECR public |
| 0c901bbf67bf36098e54ddd01fce318beed867ae | configuration navigateur de même origine servie par API, neutralité fournisseur et test de redirection corrigé |

Diff exacts joints : `private-candidate.patch`, `runtime-fixes.patch` et `authenticode-verifier.patch`. Comparaison publique : https://github.com/khemisset18/gpubnb/compare/6b655614d3b9c3fda7912742b539601ba22598f1...0c901bbf67bf36098e54ddd01fce318beed867ae.

Fichiers exactement modifiés par rapport au service privé observé :

1. `apps/api/src/workspace-gateway.ts`
2. `apps/api/src/workspace-gateway-transport.ts`
3. `apps/api/test/workspace-gateway-ws7-wire.test.ts`
4. `apps/api/package.json`
5. `apps/api/package-lock.json`
6. `package.json`
7. `package-lock.json`
8. `agent/gpubnb_agent/workspace_gateway_v10.py`
9. `agent/tests/test_windows_inventory_heartbeat.py`
10. `.github/workflows/ci.yml`
11. `apps/api/src/api-served-web-config.ts`
12. `apps/api/src/server.ts`
13. `apps/api/test/api-served-web-config.test.ts`
14. `apps/api/test/workspace-gateway-contract.test.ts`
15. `apps/web/config.js`

Aucun changement de migration, de WebCodecs/transport du client navigateur, de worker, de DLL, de lease ou de facturation dans ce candidat. La seule évolution navigateur est la configuration de ses origines, explicitée ci-dessous. Le changement Agent n'implique aucune mise à jour autorisée de l'Agent installé sur PC1 ; le conteneur API ne le déploie pas.

### Échecs examinés et corrections

La première CI privée `37990158719` était rouge : npm signalait six HIGH, Trivy douze HIGH (les mêmes dépendances dans les deux lockfiles), un mock Agent interceptait `subprocess.run` alors que le code utilise `Popen`, et le nettoyage convertissait une réponse de libération indéterminée (`None`) en échec définitif (`False`). Le job API n'avait pas commencé ses tests : Docker Hub refusait le téléchargement anonyme des services PostgreSQL/Redis.

Les versions déjà corrigées dans f797af63 ont été reprises : Fastify 5.12.5 et override brace-expansion 5.0.12, sans modification des seuils d'audit. Le mock vise `Popen`. Le seul correctif runtime Agent est `if released is not True: return released` : le runtime demeure bloqué tant que sa libération n'est pas confirmée et le callback `stopped` n'est pas envoyé prématurément. Aucun arrêt, abandon de lease ou effacement de facturation n'est ajouté.

CI `37990557334` de c03d0118 : audits dépendances et sécurité, Agent, production-gates et contrat **success** ; API **failure**, initialisation Docker Hub avant tests. Relance du seul job API, même résultat : quota anonyme, pas régression applicative démontrée. Le commit 985d616a remplace uniquement `postgres:16` et `redis:7-alpine` par leurs Docker Official Images sur `public.ecr.aws/docker/library/…`, aux mêmes tags majeurs. Toutes les étapes de tests, migrations CI, permissions, secrets éphémères, seuils et conditions d'échec sont conservées. Ce miroir est documenté par Docker : https://www.docker.com/blog/news-from-aws-reinvent-docker-official-images-on-amazon-ecr-public/. Aucun secret registry n'a été demandé ou ajouté.

La CI 985d616a a pu initialiser les services via ECR : 795 tests API exécutés, 790 pass, 2 skipped et 3 fail. Deux contrôles existaient déjà sur la baseline privée et refusaient la détection `.onrender.com` dans `apps/web/config.js` ; le troisième utilisait `source` non défini au lieu de `api`. Aucun test ni ratchet n’a été désactivé. Le commit 0c901bbf corrige la variable et restaure le config statique provider-neutral. Pour préserver le fonctionnement de Stage, une route `/config.js` servie par l’API fournit les defaults `window.location.origin` avant la configuration commune. Le code ne reflète aucun Host reçu et conserve les overrides explicites existants ; le site statique conserve `/api`. Cette route utilise les hooks HTTP existants et n’ajoute aucune permission ou exception d’authentification. Deux tests Fastify/VM vérifient les origines, les overrides, le non-reflet d’un Host arbitraire, les en-têtes JS/no-store et les defaults du site statique.

**État final de la CI 0c901bbf : SUCCESS**, run [37991671609](https://github.com/khemisset18/gpubnb/actions/runs/37991671609), terminé à 21:11:04Z ; prephysical [37991671696](https://github.com/khemisset18/gpubnb/actions/runs/37991671696) SUCCESS. Les six jobs CI sont verts : API, Agent, dépendances, Trivy/sécurité, production-gates et contrat. API : 797 tests, 795 pass, 2 skipped, zéro échec ; build et TypeScript strict réussis. Agent : 617 tests, 3 skipped, zéro échec. Voir `ci-evidence.json` pour les IDs de jobs et le relevé final. La CI 985d616a est `37991063990` (failure) et sa prephysical `37991064032` (success). Ne jamais interpréter un job absent, queued ou skipped comme un succès.

Tests supplémentaires locaux en environnement isolé : 626 tests Agent sur f797af63 (3 ignorés, zéro erreur/échec), 617 sur le candidat privé (3 ignorés, zéro erreur/échec), 43 tests API ciblés et 25 navigateur sur f797af63, 6 tests transport/ws@7 réel et 29 tests ciblés configuration/architecture/contrat sur le candidat privé ; TypeScript `--noEmit` passe sur les deux variantes. Une vérification locale avec l’enregistrement réel `@fastify/static` confirme la priorité de `/config.js`, la réponse no-store et l’accès à `windows-native-desktop.html`. Les tests locaux ciblés ne remplacent pas la suite API avec PostgreSQL et Redis en CI. Pas de PowerShell ni Rust installés dans ce conteneur : preuves Windows prises dans les jobs GitHub, aucune exécution Windows locale annoncée.

## 2. Causes démontrées, chronologie et limites

### Défaut gateway démontré

Le lockfile utilise `ws@7.5.13`. Certains callbacks ws@7 livrent la charge binaire comme Buffer/ArrayBuffer/Buffer[] sans le second argument booléen attendu par le traitement antérieur. La charge clavier/souris binaire légitime de 32 octets était classée comme texte, rejetée et entraînait une fermeture rapide. Le correctif respecte le booléen explicite lorsqu'il existe, sinon utilise la représentation binaire ; les chaînes restent du texte UTF-8. Les entrées Windows Native demeurent exclusivement binaires et de longueur exacte : aucune tolérance de sécurité ajoutée.

Preuve logs Render existants : canal `21d327a1`, rejet à `16:25:36.324834184Z`, fermeture `16:25:36.390790017Z` (~66 ms). Agent : première trame locale à 16:25:33, premier lot à 16:25:34, fermeture à 16:25:37 avec 9 trames, puis HTTP 409 à 16:25:40. Le test réel de la bibliothèque verrouillée reproduit le comportement, accepte l'entrée binaire et rejette le texte de même taille.

### Défaut helper démontré par reproduction automatisée

Le helper pouvait voir deux octets d'en-tête TCP, puis appeler une lecture exacte bloquante alors que le masque ou la charge n'était pas encore arrivé. Dans la boucle commune média/entrée, cette attente pouvait interrompre les deux traitements jusqu'au délai socket. Le correctif inspecte une trame entière validée et bornée avant sa consommation ; une trame incomplète ne perd pas ses octets et possède un délai par connexion. Les tests reproduisent une arrivée octet par octet, l'expiration, les en-têtes malformés, EOF et un nouveau pair. Les fences d'entrée, taille de trame, capability token et contrôles d'epoch sont conservés.

Cette reproduction prouve le défaut logiciel et la propriété du correctif. Les logs physiques disponibles n'identifient pas chaque fragmentation reçue par le helper ; ils ne permettent pas d'attribuer toutes les coupures physiques à cette seule cause. Le commit antérieur cf7130c qui traite les déconnexions du pair ne suffisait pas à prouver leur disparition.

### Erreurs secondaires et contrôle Agent encore incomplet

| Observation UTC | Interprétation soutenue |
|---|---|
| canal 2a49eacc fermé à 16:22:49, 409 à 16:22:54 | 409 intervient après fermeture ; ne déclenche pas celle-ci |
| plusieurs `WinError 10058` avec `ws_closed` | utilisation d'un socket déjà arrêté ; initiateur non identifié par ces lignes seules |
| bc693f2c local 18:40:47, premier lot 18:40:53 | retard de six secondes observé entre ces jalons, cause non isolée |
| Render ff26fce4 timeout 18:41:53.742 après 15.010 s ; Agent dispatch 18:42:53 | ouverture traitée côté Agent après expiration gateway |
| Render 02b163bc timeout 18:42:34.329 après 15.021 s ; Agent dispatch 18:42:53 | deuxième ouverture également tardive |
| ces deux canaux : première trame, close/cancel à 18:42:57, une trame | absence de session durable ; handlers arrivés trop tard |
| `sender_shutdown_timeout` à 18:43:12, 409 ensuite | tâches d'envoi encore vivantes après annulation/fermeture |

Les journaux Agent ont une résolution à la seconde ; les logs Render sont plus fins. Les messages sans identifiant de canal ne doivent pas être attribués arbitrairement. `ConnectionAbortedError` / `ConnectionResetError` à l'ouverture locale prouvent un transport avorté, pas une erreur NVENC. La chaîne complète navigateur WebCodecs → gateway → Agent → helper ne peut pas être reconstruite à la milliseconde sans traces navigateur/helper corrélées. Les temps de polling/traitement, la contention, les queues et les opérations de shutdown restent des risques résiduels : augmenter un délai ne constitue pas un correctif démontré.

### Capture, NVENC et queues examinés

La DLL utilise **Windows Graphics Capture**, `Direct3D11CaptureFramePool::CreateFreeThreaded` avec deux buffers, `TryGetNextFrame`, un état de fermeture atomique et une copie texture clôturée par une fence GPU avant restitution de la trame. Le contrôle exact GPU/LUID et le diagnostic D3D11 sont maintenus. Le nom de méthode locale `AcquireNextFrame` ne doit pas faire confondre ce code avec IDXGIOutputDuplication.

NVENC est initialisé en mode synchrone (`enableEncodeAsync=0`), et `nvEncLockBitstream` utilise `doNotWait=0`. C'est une attente potentiellement bloquante à surveiller ; ce n'est pas une preuve de panne NVENC lors des tests. Le guide NVIDIA recommande l'interrogation des capacités et décrit les modes sync/async ; aucune migration vers un SDK plus récent ou un mode asynchrone n'a été improvisée. La DLL et son ABI ne changent pas dans ce candidat.

Les bornes de pending browser (items et octets), le base64 strict, la taille d'entrée et les chemins authentifiés sont testés. Les délais réseau bloquants et la vidange des tâches Agent restent à observer pendant la qualification réelle. Aucun journal capture/NVENC dédié n'a été trouvé lors de l'inventaire restreint fourni ; aucun événement Windows ciblé Display/nvlddmkm/Application Error/Hang/WER n'a été trouvé aux deux fenêtres. Une absence de logs n'exclut pas un défaut graphique.

Documents primaires consultés :

- Microsoft WGC CreateFreeThreaded : https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded?view=winrt-26100
- Microsoft DXGI AcquireNextFrame (pour distinguer timeout/invalidité, pas attribuer l'implémentation WGC) : https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutputduplication-acquirenextframe
- NVIDIA NVENC Programming Guide : https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/nvenc-video-encoder-api-prog-guide/index.html

## 3. Chaîne de confiance Windows

### Ce qui est effectivement vérifié

Les quatre fichiers PC1 étaient annoncés Authenticode `Valid`, avec le même sujet `CN=GPUbnb LOCAL PHYSICAL TEST ONLY 2026-09-21` et thumbprint SHA-1 `6B8A9EA7C26791668CA31863DC68A7B5F88FC6EC`. Ce certificat est une identité de qualification locale, pas une identité production approuvée. Le sujet et le thumbprint SHA-1 ne permettent pas de calculer son SHA-256.

Le helper Rust exige un pin worker SHA-256 compilé, non vide/non nul, utilise le chemin worker fixe Program Files, conserve le handle vérifié, lance dans le token renter et lie le pipe au SID/PID attendu. La plateforme utilise WinVerifyTrust, vérifie la chaîne/révocation et le signataire principal SHA-256 contre la liste autorisée ; aucun certificat de timestamp n'est accepté comme signataire du code. La DLL média doit passer son pin SHA-256 compilé avant chargement depuis son emplacement fixe, avec recherche DLL restreinte.

Le worker expose `--build-policy --json` avec le commit source et le pin média. `agent/tools/windows_native_build_qualification.ps1` contrôle les signataires worker/DLL installés, la policy du worker et leur cohérence avec le checkout propre. Ces vérifications ne doivent pas être retirées si le worker ancien ne correspond pas au candidat récent.

**Limite distincte :** la découverte du helper par l'Agent utilise son chemin fixe et interdit PATH/chemins relatifs ; le code examiné ne constitue pas à lui seul un contrôle Authenticode runtime du helper. Sa vérification obligatoire de distribution/installation reste donc nécessaire. Ne pas présenter le contrôle du worker comme une vérification automatique du helper par l'Agent.

Le script de signature existant utilise le certificat exact du magasin du poste de signature, exige une clé accessible à ce poste, une validité courante et une URL HTTPS, puis SignTool `/fd SHA256 /tr <URL> /td SHA256`. Il appelle ensuite le vérificateur avec `-Required -RequireTimestamp -ExpectedSignerSha256`. Aucune exécution de ce script n'a eu lieu. La clé doit rester sur un poste de signature dédié ou dans un service managé, inaccessible à PC1.

### Vérificateur Authenticode f797af63

Le script corrigé s'arrête sur chemin inexistant, pin explicitement vide/malformé, signature invalide (même sans certificat retourné), signature absente lorsqu'elle est obligatoire, signataire non autorisé et horodatage obligatoire absent. Il emploie LiteralPath, ne publie son JSON qu'après validation de tous les fichiers et conserve les switches Required/RequireTimestamp et le pin ExpectedSignerSha256.

Le mode facultatif n'accepte un fichier non signé que si son statut est exactement NotSigned et qu'aucune exigence de signature/pin/timestamp n'est activée. Ce mode n'est pas permis pour le futur candidat installé. Les 34 tests comprennent mocks des états invalides, preuve de code de sortie non nul, fichier Windows existant signé, fichier temporaire non signé et copie altérée non exécutée ; aucun certificat de test ni nouvelle identité de confiance n'est créé. Ces tests ne valident pas le certificat local de qualification actuel.

### Informations manquantes bloquantes

- SHA-256 DER du certificat feuille autorisé et correspondance au pin worker compilé de l'artefact CI.
- EKU Code Signing explicite (OID 1.3.6.1.5.5.7.3.3), NotBefore/NotAfter et validité au moment futur de signature.
- Chaîne et politique de confiance réellement admises sur le poste dédié, le worker et PC1 ; vérification de révocation applicable.
- Preuve de disponibilité de la même identité sur le poste/service dédié, protection/non-exportabilité de clé et absence d'accès depuis PC1, sans export de secret.
- Policy compilée du worker PC1 : sourceCommit et mediaSignerSha256 ; manifeste qualification correspondant. Le worker PC1 daté du 3 octobre ne peut pas être déclaré compatible avec le build du 9 octobre sans preuve.
- URL HTTPS RFC 3161 explicitement approuvée et compatibilité SignTool/chaîne timestamp vérifiée.
- Empreinte finale du binaire signé, horodatage et résultats réels Authenticode : inexistants car aucune signature autorisée.

La procédure de métadonnées publiques en lecture seule est fournie séparément. Elle n'a pas été exécutée et ne constitue pas une demande d'intervention PC1.

### Services d'horodatage étudiés, aucun approuvé

| Service | Documentation / résultat | Blocage |
|---|---|---|
| DigiCert | RFC3161 documenté, URL publique documentée en HTTP : https://knowledge.digicert.com/general-information/rfc3161-compliant-time-stamp-authority-server | HTTPS ne peut pas être présumé par changement de schéma |
| Sectigo | RFC3161 documenté, exemple HTTP : https://www.sectigo.com/resource-library/time-stamping-server | endpoint HTTPS exact non confirmé |
| GlobalSign | service RFC3161 : https://www.globalsign.com/en/timestamp-service ; API HTTPS REST retourne un token | URL directe compatible SignTool non confirmée ; API REST différente |
| FreeTSA | HTTPS RFC3161 `https://freetsa.org/tsr` publié : https://freetsa.org/index_en.php | confiance TSA et compatibilité Windows non démontrées ; aucun ajout de root autorisé |

Microsoft documente `/tr` pour RFC3161 et `/td SHA256`, ainsi que l'EKU Code Signing par défaut : https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool. Une URL techniquement documentée ne vaut ni approbation de fournisseur ni autorisation d'élargir le magasin de confiance.

## 4. Artefacts et empreintes

L'archive GitHub de l'artefact `11639950809`, run `37978709636`, a été téléchargée et son digest recalculé :

- archive SHA-256 `118ecfb2eb65d488fa867621f8672f0ef07e72b5f0d6cb363c7bb612a074cc00` — conforme au digest GitHub ; expiration 2026-10-23T19:14:15Z ; non expirée à la lecture ;
- `gpubnb-windows-stream.exe`, 465408 octets ; SHA-256 `6957c09bfe2afea15718a8740b8ea738236a3274dfa9b9da1fcb0d573fbb905c` ;
- PE Machine 0x8664 / AMD64, PE32+ 0x20b ; table certificat offset/taille zéro : **non signé** ;
- version Cargo déclarée 0.1.0, commit source fe0b1cde ; ne pas inventer de FileVersion embarquée ;
- feature `physical-qualification` ; pin worker du build CI `200208e0ef9dc3de4911df5541e6b11506c07de2820849006311cb68b342965a` ; compatibilité PC1 non prouvée.

Les sources helper/plateforme sont identiques dans f797af63 : le correctif PowerShell ne nécessite pas en soi un autre binaire Windows. Le build release-candidate exécuté en CI avec un pin factice n'est pas l'artefact uploadé et ne constitue pas un candidat installé approuvé. Aucun nouveau worker/DLL signé n'est disponible dans ce dossier. Le manifeste JSON laisse explicitement null les champs inconnus, dont signedFileSha256 et timestamp.

| Fichier PC1 historique | Taille | SHA-256 |
|---|---:|---|
| Agent | 22259240 | 073C98950248301BB152AA0EBD08C5E72D0A118F294388B584029CD145E981DA |
| helper | 466264 | D114BCA3293DA78481DEE1D53D06C7B91B4A94F08CCDE4A61D268EA73D039690 |
| worker | 183632 | 720325ACAC59D5E7E24F25F2EC72E13CEF1E1071249943F024FF135844091579 |
| DLL média | 66904 | 510D559B056BA094F8DC06B73D4C6D7BCE46CA97FA774524E605844AD16FC9DE |

Un hash signé PC1 ne se compare pas directement au hash non signé CI pour identifier son commit. FileVersion et ProductVersion étaient null pour ces fichiers. Aucun commit installé PC1 n'est affirmé.

## 5. Préservation des protections

Les correctifs gateway changent la classification du transport et son test, pas l'authentification ni les contrats d'entrée. Le helper conserve les contrôles token/epoch et ne consomme pas une trame invalide pour satisfaire un test. Les pins WinTrust worker/DLL, le token renter, les pipes SID/PID, les chemins fixes et la preuve GPU ne changent pas. Le nettoyage Agent attend une libération confirmée avant d'enlever l'état bloqué. La CI garde les audits HIGH/CRITICAL et les production-gates. Les branches sont de préparation ; aucune fusion, activation publique Windows Native, modification de production ou configuration de confiance n'a eu lieu.

Preuves à recouper : diff fe0→f797 limité aux trois fichiers Authenticode ; diff privé joint limité aux quinze fichiers listés ; suites CI lease/worker/Agent/contrat/production et tests de rejet natif. Les tests prouvent les cas exercés, pas l'absence universelle de régression.

## 6. Plan d'exécution futur et retour arrière — NON EXÉCUTÉ

### Prérequis et autorisations séparées

1. Relever à nouveau les SHA exacts des branches, CI et déploiement privé ; le présent état peut évoluer.
2. Confirmer le certificat et sa policy par procédure autorisée distinctement en lecture seule. Toute différence de pin, source worker ou chaîne arrête la préparation de signature ; ne pas recompiler avec un pin ad hoc.
3. Faire approuver explicitement l'URL HTTPS RFC3161. Garder la même identité, sans nouvelle racine, PFX ni clé privée transférée.
4. Obtenir l'autorisation distincte de signature. Utiliser les scripts existants sur le poste/service dédié, puis `verify-windows-authenticode.ps1 -Required -RequireTimestamp -ExpectedSignerSha256 <pin confirmé>` ; renseigner manifeste final et hash après signature. Vérifier aussi l'horodatage précis avec SignTool ; le JSON du script indique la présence du timestamp, pas sa date détaillée.
5. Obtenir séparément autorisation de déploiement Render privé, de remplacement helper/redémarrage éventuellement requis sur PC1, puis du test physique. Une autorisation pour l'une ne couvre pas les autres.

### Render privé, seulement après autorisation

1. Cibler uniquement `srv-dau86i2d0e5s73elmk10`, contrôler nom/environnement, auto-deploy et previews désactivés ; sauvegarder commit/ID deployment et configuration non secrète. Ne pas afficher les valeurs de secrets.
2. Avant lancement, vérifier en lecture seule l'état des migrations. Le Dockerfile lance `prisma migrate deploy` au démarrage : **s'il existe une migration en attente, arrêter**, car un déploiement appliquerait une mutation DB non incluse dans ce plan. Aucun fichier de migration n'est changé, ce qui ne garantit pas une DB déjà à jour.
3. Sélectionner explicitement le SHA privé 0c901bbf, sans fusion sur main et sans déployer toute f797af63 ; garder les variables/policies de sécurité, leases, isolation et facturation actuelles.
4. Déclencher manuellement uniquement le service de qualification. Consigner le SHA effectivement construit, l'ID de déploiement, son état final, /health et les journaux sans secrets. Aucune session physique ne suit automatiquement.
5. En cas d'erreur d'authentification, migration inattendue, divergence SHA ou santé insuffisante, arrêter la qualification. Retour arrière uniquement après autorisation : ancien deployment `dep-db4j8gom7kps73c1u4p0` / SHA 6b655614, sans rollback DB ni manipulation de leases.
6. L'ancien état réintroduit le défaut ws@7 et ses dépendances vulnérables : c'est un repli de qualification temporaire, pas une version sûre pour ouverture publique. Garder Stage fermé à la qualification jusqu'à nouvelle revue.

### PC1, seulement après autorisation distincte

1. Vérifier qu'aucune session rentable active ne serait interrompue ; appliquer le mécanisme existant d'arrêt/quiescence qui préserve suspension, leases et facturation, jamais forcer la libération d'une lease. Si une mise à jour exige un redémarrage, obtenir son autorisation explicite avant toute action.
2. Relire hash helper attendu `D114…9690`, hashes worker/DLL/Agent, signature/pins et policy compilée ; comparer au dossier signé final. Si la baseline a changé, arrêter et refaire la revue.
3. Préparer une copie de retour arrière du helper existant dans un emplacement opérateur protégé, conserver ACL et métadonnées utiles, puis vérifier la copie SHA-256/Authenticode. Ne pas remplacer worker, DLL ou Agent dans cette opération.
4. Vérifier le candidat signé avant copie et après copie dans l'emplacement temporaire protégé : hash final manifesté, AMD64, signer exact, timestamp, policy worker compatible, source/provenance CI. Un pin non confirmé interdit l'installation.
5. Procéder au seul remplacement helper autorisé en conservant les ACL de Program Files et les règles existantes. Tout arrêt/redémarrage doit être celui explicitement autorisé et documenté ; ne pas improviser une autre commande ou toucher à la session Windows.
6. Relire hash/signature du fichier final. En cas de défaut, stopper la qualification et, après autorisation de retour arrière, restaurer uniquement la copie helper vérifiée, contrôler `D114…9690` et les autres fichiers inchangés. Ne pas retirer le contrôle de signature pour faire démarrer le helper.

Les opérations PC1 seront exécutées une commande PowerShell à la fois, seulement dans le périmètre accordé. Aucune commande d'installation n'est fournie avec une fausse empreinte finale : le plan ne devient exécutable qu'une fois le manifeste signé complété.

### Qualification physique future

Après toutes les autorisations : session réelle PC1→PC2 d'au moins **300 secondes**, vidéo décodée et rendue, clavier et souris réellement observés, aucune fermeture/reconnexion inattendue, aucune boucle de preuve/reprise ; correlater channel/session/epoch et timestamps navigateur/gateway/Agent/helper, compteurs frames, entrées et raisons de fermeture. Vérifier capture/exact GPU/NVENC, intégrité du worker, respect des leases et facturation normale. Faire la validation suspension/reprise selon les contrats existants, sans usage gratuit ou bypass.

Collecter aussi les délais contrôle dispatch/ready, tailles/âges des queues, durées de capture/encode et fin des senders. Si les retards Agent ou les sockets locaux interrompent encore la session, le critère échoue même si le test ws@7 reste vert. Une simple connexion ouverte pendant cinq minutes ne suffit pas.

## 7. Risques résiduels et critères de blocage

- Aucune preuve physique de 300 secondes ; fermeture courte encore possible pour une autre cause.
- Ouvertures Agent tardives et tâches d'envoi terminant après fermeture ; origine complète non isolée.
- Attentes synchrones capture/NVENC et API réseau ; pas de diagnostic NVENC physical exhaustif.
- Certificat/pins, worker source et TSA non confirmés ; artefact CI non installable en l'état.
- Le comportement de même origine de Stage est conservé via configuration API ; ses éventuels défauts de WebCodecs ne sont pas exclus par ces tests.
- Baseline PC1 non reliée de façon vérifiable à un commit ; les dates/signatures ne suffisent pas.
- CI API infra rouge doit être distinguée d'un succès de validation ; toute CI obligatoire restante rouge ou non terminée bloque le candidat exécutable.
- Rollback au gateway ancien réintroduit des défauts et vulnérabilités connus ; ne pas ouvrir Windows Native publiquement.

**GO préparation** pour le code et le dossier vérifiable. **NO-GO signature** tant que certificat/policy/TSA ne sont pas établis et approuvés. **NO-GO déploiement et intervention PC1** tant que preuves, manifeste final et autorisations distinctes manquent. **GPUbnb n'est pas déclaré réparé** avant le test physique réussi.
