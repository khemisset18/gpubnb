# GPUbnb — étude de durcissement HTTPS RFC 3161, 15 octobre 2026

Décision vérifiée le 15 octobre 2026 : **GO preuve technique HTTPS RFC 3161 et
préparation ; NO-GO signature GPUbnb, installation et déploiement.** Le workflow
Windows sécurisé, les six jobs de CI générale et la préqualification réussissent
sur le commit `d21af2fbf1f110dff5c0cab7a460035fb2ddefa6`.

Aucune clé privée GPUbnb, aucun binaire GPUbnb signé, aucune intervention PC1/PC2,
opération Render, modification des magasins de confiance ou fusion. Coût
supplémentaire : **0 €**. L'essai porte sur une copie jetable d'un exécutable
Microsoft déjà signé ; le signataire primaire est conservé. Il ne vaut ni
approbation du fournisseur, ni autorisation d'utilisation opérationnelle.

Le présent dossier est documentaire. Les sources exécutées et leurs workflows
sont ceux du commit ci-dessus, sur la branche
`prep/stage4-osslsigncode-hardened-20261015`. Le manifeste distingue leurs
empreintes des preuves et fichiers de rapport ajoutés ensuite.

## Cause démontrée

Le run [38658787497](https://github.com/khemisset18/gpubnb/actions/runs/38658787497)
a testé le binaire Windows officiel osslsigncode 2.14. Windows a constaté
`RemoteCertificateNameMismatch` pour `wrong.host.badssl.com`, avec une chaîne
sans erreur. Osslsigncode a pourtant reçu HTTP 405 dans cette connexion TLS.
Son code de sortie 1 résultait de la réponse HTTP, pas d'un refus TLS.

Les sources 2.14, commit `beec94e308d1a1e03ca17b05fe089d93c6303e90`,
expliquent ce résultat : dans le transport OpenSSL >=3, `http_tls_cb` appelle
`SSL_set_tlsext_host_name` pour SNI, sans configurer le nom attendu pour la
vérification du certificat. SNI sélectionne le certificat du serveur. La
validation de sa chaîne ne lie pas automatiquement ce certificat au nom DNS.
L'API [SSL_set1_host](https://docs.openssl.org/3.5/man3/SSL_set1_host/) est
explicitement prévue pour configurer cette vérification sur l'objet SSL.

Deux autres chemins permissifs sont supprimés : l'échec ou l'absence du fichier
CA pouvait laisser poursuivre sans `SSL_VERIFY_PEER`; une CRL manquante était
ignorée par le callback. Ce sont des constats distincts du défaut de nom DNS.
Mettre à jour la bibliothèque seule ne corrige pas l'absence du nom attendu.

## Construction et périmètre du correctif

Le patch est conservé dans `scripts/third-party/osslsigncode/tls-fail-closed.patch`.
La configuration et son empreinte figurent dans `sources.lock.json` du même
répertoire. Le script `build-windows.ps1` et le workflow
`stage4-osslsigncode-hardened.yml` construisent uniquement dans `RUNNER_TEMP`,
sur un runner Windows 2022 hébergé GitHub du dépôt public et une branche dédiée.
Il n'y a ni nouveau service payant, ni cache ou artefact ajouté par ce workflow.

Le fork est identifié comme `2.14-gpubnb-tls1`. Il impose le nom DNS SAN sur la
connexion SSL réelle, contrôle les retours de configuration du nom et de SNI,
refuse le repli vers Common Name et les jokers partiels, exige des fichiers CA
et CRL explicites et refuse toute erreur de chargement. Le callback TLS ne
transforme aucune erreur de certificat en succès. Les horodatages HTTP et
`-noverifypeer` sont refusés. TLS 1.2 minimum et un délai HTTP/TLS de 30 secondes
sont configurés. Aucun appel de signature de code n'est employé par la sonde.

OpenSSL **3.5.9 LTS** et zlib **1.3.2** sont construits depuis les archives
officielles épinglées par taille et SHA-256. La branche OpenSSL 3.5 est maintenue
jusqu'au 8 avril 2030 selon la
[politique officielle](https://openssl-library.org/policies/releasestrat/).
La configuration portable C évite d'installer NASM; elle conserve les contrôles
TLS et certificats. Les bibliothèques sont liées statiquement et les protections
PE sont contrôlées. Les versions et empreintes des compilateurs, bibliothèques
installées et du résultat sont incluses dans le manifeste de construction.

Les sources OpenSSL et zlib passent leurs suites amont avant la sonde. La suite
OpenSSL utilise quatre workers TAP, comme sa CI Windows officielle, sans retirer
de recette. La suite amont osslsigncode n'est pas revendiquée comme exécutée :
elle utilise son serveur HTTP et des opérations de signature avec ses clés de
test. Les régressions TLS/RFC 3161 demandées sont vérifiées par une suite dédiée,
sur une copie d'un PE Microsoft déjà signé, sans clé GPUbnb.

## Résultats effectivement obtenus

| Contrôle exécuté | Résultat et preuve |
| --- | --- |
| Construction AMD64, analyse syntaxique PowerShell, suites OpenSSL/zlib, régressions Authenticode et sonde Windows | [38670517814](https://github.com/khemisset18/gpubnb/actions/runs/38670517814), job [116212308897](https://github.com/khemisset18/gpubnb/actions/runs/38670517814/job/116212308897) : **success**, terminé à 02:42:20 UTC |
| OpenSSL 3.5.9 | **347 fichiers de tests, 3 820 tests, PASS**, skips amont des fonctions/fournisseurs non configurés conservés ; aucun filtre de recettes |
| zlib 1.3.2 | **13 tests, zéro échec** ; version à la compilation et à l'exécution mesurée |
| Vérificateur Authenticode standard inchangé | **34 vérifications PowerShell 7 + 34 Windows PowerShell 5.1**, toutes réussies |
| Mauvaise autorité | Windows `UntrustedRoot` ; OpenSSL `self-signed certificate`, code 1, aucun fichier de sortie |
| Mauvais nom | Windows `RemoteCertificateNameMismatch`, aucune erreur de chaîne ; OpenSSL `hostname mismatch`, code 1, aucun fichier de sortie |
| Certificat expiré | Windows `NotTimeValid` ; OpenSSL `certificate has expired`, code 1, aucun fichier de sortie |
| Réponse RFC 3161 invalide | TLS valide, HTTP 200, `application/timestamp-reply`, corps JSON de 115 octets ; rejet ASN.1 `TS_RESP`, code 1 |
| CA absente, CRL absente, URL TSA HTTP | Trois rejets explicites, tous réussis |
| PE altéré | Windows `HashMismatch`, SignTool code 1, rejet confirmé |
| HTTPS positif | `https://rfc3161.ai.moda/`, horodatage RFC 3161 SHA-256, Windows `Valid`, SignTool code 0, zéro avertissement et zéro erreur |
| CI générale | [38670517761](https://github.com/khemisset18/gpubnb/actions/runs/38670517761), tentative 3, **6/6 jobs success**, terminé à 12:08:41 UTC |
| API | **807 tests : 805 réussis, 2 ignorés, zéro échec** ; build et TypeScript strict réussis |
| Agent | **626 tests : 623 réussis, 3 ignorés, zéro échec** |
| Préqualification automatisée | [38670517781](https://github.com/khemisset18/gpubnb/actions/runs/38670517781), **2/2 jobs success** ; aucune session physique |

L'échec d'infrastructure des deux premières tentatives de CI était le refus du
miroir **ECR public**, `docker pull public.ecr.aws/docker/library/postgres:16` :
`toomanyrequests: Data limit exceeded`, avant les tests API. La relance différée
réussit sans changer le workflow, les images, les seuils ni un test. Ce n'était
pas un défaut applicatif démontré.

L'essai précédent `83395a13`/run `38668276378` avait déjà validé le nom TLS et le
cas positif, mais deux négatifs n'étaient pas prouvés : CRL d'un autre émetteur
pour le certificat expiré et corps vide du service de réponse invalide.
Le dernier commit utilise la CRL propre à l'émetteur COMODO et une réponse HTTP
invalide mesurée de httpbin.org. Les contrôles TLS ne sont pas assouplis.
La collecte du certificat public du site expiré conserve le refus de handshake.
Le code utilise ensuite la CRL signée sur la vraie connexion native OpenSSL.

### Empreintes finales de cette exécution

| Objet | SHA-256 du fichier complet |
| --- | --- |
| Outil AMD64 construit, 5 031 424 octets, `2.14-gpubnb-tls1` | `4cdc043aa128d5f30523d38ebcb4d79238cdaeb55fdf5cf94ce4f8e2903a5874` |
| Patch TLS appliqué | `1dc68b278a134d0b9ea3408d7886b5cba946157df7f9a9fb2da07bc2775237e5` |
| Fixture Microsoft source, restée intacte | `bfb46af89433268872ddb43d1ca7a3f433452ee91ed356a9786940f90118e285` |
| Copie jetable avant nouvel horodatage | `b6a6c492c9aedf6e7bae7451fe995823eb663720955981e600e18a33ee40ff74` |
| Copie jetable après nouvel horodatage | `b05b51b02a6b93342d7805613c61dbd0dac2b0b1ba38e4862927a0c15bec8146` |

Il s'agit des empreintes SHA-256 des fichiers entiers, distinctes du digest
Authenticode imprimé par SignTool. Les octets de signature principale, le
contenu et les attributs signés sont identiques avant/après. Le certificat
principal Microsoft conserve le SHA-256
`d33927e4dda9b91def9f8ed282549a49217ed8cacf54577a690963cbc5eff3ed`.

Le jeton émis à **2026-10-15T02:42:12Z** est lié à la signature primaire et
utilise SHA-256. La TSA DigiCert possède l'EKU Timestamping exclusif et critique.
Sa chaîne est reconnue à partir d'une racine déjà présente. Windows et SignTool
SDK 10.0.26100.0 x64, version produit `10.0.26100.7705`, la vérifient.
Les magasins racines avant/après sont identiques. Aucun certificat privé ni
nouvelle racine n'est nécessaire pour cette preuve sur le runner.

Les versions, empreintes des archives, compilateurs, bibliothèques et exécutables,
les détails de chaque négatif, les résultats Windows/SignTool et les contrôles
cryptographiques figurent dans `build-and-probe-evidence.json`.
`release-manifest.json` synthétise la provenance ; `ci-evidence.json` donne les
jobs et conclusions exacts ; `SHA256SUMS` permet de contrôler le dossier et les
sept nouveaux fichiers sources. L'outil et les fixtures ont été supprimés du
runner : **aucun exécutable prêt à installer n'est livré** par ce dossier.

### Protections GPUbnb préservées

Le diff du commit de référence `7d6a941b6a73e40e0b9986c55735046f32ef6f62` au
commit testé contient **sept ajouts, aucune modification de fichier existant** :
deux workflows isolés, deux sondes PowerShell et trois fichiers de construction.
L'Agent, le gateway, le helper, le worker, les pins, le vérificateur standard et
ses tests, la CI générale, les leases, l'authentification, l'isolation, la
suspension/reprise et la facturation sont identiques. Leur diff a été contrôlé
vide, en complément de la CI et des barrières de préqualification réussies.

Empreintes des contrôles standard inchangés :

- `scripts/verify-windows-authenticode.ps1` : `16b847aa08317d8f74364fa2ed97a1d36f5c9b5aaad1d3d7616041832872255a`.
- `scripts/tests/verify-windows-authenticode.tests.ps1` : `74fbd63e4e177d8163a79b7c8382236a7deb21cf498286dcbbadda0c758de0e1`.

## Critères de la preuve Windows

| Contrôle | Condition indispensable |
| --- | --- |
| Mauvaise autorité | Erreur de chaîne constatée indépendamment sous Windows et refus explicite de l'autorité par OpenSSL |
| Mauvais nom DNS | Windows constate le seul défaut de nom; OpenSSL refuse pour `hostname mismatch` avant HTTP |
| Certificat expiré | Windows constate `NotTimeValid`; OpenSSL refuse explicitement le certificat expiré |
| Réponse RFC 3161 invalide | HTTPS valide, HTTP 200 et bon Content-Type, mais DER invalide; refus au décodeur RFC 3161 |
| CA ou CRL manquante | Échec avant transfert HTTP |
| URL d'horodatage HTTP | Refus explicite avant transfert |
| Fichier PE altéré | Windows et SignTool refusent l'intégrité |
| Cas positif | Horodatage SHA-256 lié à la signature primaire, chaîne TSA reconnue, signature principale inchangée |

Un timeout, HTTP 405 ou une erreur générale de transport ne peut pas valider un
test négatif TLS. La réponse ASN.1 invalide utilise un service public de test
HTTP; son code de route autorise POST et son comportement est contrôlé avant
l'appel natif. Cela évite de créer une autorité de test ou de modifier Windows.

Le cas positif exige `Get-AuthenticodeSignature = Valid`, un horodateur présent,
SignTool `verify /pa /all /v /tw` code 0 et le vérificateur GPUbnb standard avec
signature obligatoire, horodatage obligatoire et SHA-256 du signataire primaire
de la fixture. Les octets de signature, le contenu signé, les attributs signés
et l'empreinte du certificat primaire doivent rester identiques. Les SHA-256 du
fichier avant et après horodatage sont mesurés séparément.

La chaîne TSA est contrôlée en mémoire à partir des racines présentes avant les
essais, avec EKU Timestamping exclusif et critique, révocation en ligne pour tous
les certificats hors racine et aucune tolérance d'erreur. Les certificats fournis
par le fournisseur restent des éléments de chaîne, sans devenir des racines de
confiance. Les magasins racines sont comparés avant/après construction et essais.

## Limites et critères d'arrêt

La validation TLS native vérifie la chaîne complète et le nom. Sa politique CRL
reste `X509_V_FLAG_CRL_CHECK`, rendue stricte : révocation de la feuille TLS, avec
refus si la CRL est absente, périmée ou inapplicable. Il ne s'agit pas d'un
contrôle CRL natif de tous les intermédiaires TLS. La révocation de la chaîne TSA
hors racine est contrôlée séparément sous Windows. Les CRL peuvent être
téléchargées depuis leurs CDP HTTP : leur signature, leur applicabilité et leur
validité sont contrôlées sur la connexion native; les requêtes TSA restent HTTPS.

L'authentification PGP des publications amont et la reproductibilité binaire ne
sont pas démontrées. Cette étude est une revue ciblée, une construction traçable
et des tests; elle ne constitue pas un audit indépendant de tout OpenSSL ou
osslsigncode. L'outil construit est non signé, réservé au runner isolé et supprimé
après les essais. Son utilisation future nécessiterait une provenance et une
empreinte approuvées pour l'artefact réellement conservé.

La reconnaissance de la TSA est vérifiée sur le Windows du runner. Les magasins
de PC1/PC2 ne sont ni examinés ni modifiés. L'URL du fournisseur n'est pas
considérée comme approuvée pour GPUbnb. L'indépendance du poste de signature et
la protection de la clé GPUbnb restent des blocages distincts. Le certificat
existant expire le **20 octobre 2026 à 22:23:47 UTC**, soit le 21 octobre à
00:23:47 à Paris. Aucun recul d'horloge ni horodatage artificiel n'est permis.

Toute erreur obligatoire, identité primaire différente, empreinte inattendue,
nouvelle racine, chaîne/révocation incertaine ou résultat CI manquant impose un
NO-GO. Une panne réseau reste un échec de validation, jamais une preuve de refus
de certificat. Aucun test ne permet de déclarer la session GPUbnb physiquement
stable : les 300 secondes réelles de vidéo, clavier et souris restent à démontrer.

## Décisions et prochaine étape

| Périmètre | Décision |
| --- | --- |
| Preuve Windows isolée de l'horodatage HTTPS gratuit, avec TLS corrigé | **GO technique**, sur le commit et l'environnement testés |
| Préparation d'une procédure GPUbnb et revue des sources | **GO préparation** |
| Binaire amont 2.14 non corrigé | **NO-GO**, défaut TLS démontré |
| Approbation de ai.moda pour GPUbnb | **Non accordée** ; disponibilité gratuite observée, conditions, pérennité et acceptation opérationnelle à valider |
| Signature d'un binaire GPUbnb | **NO-GO**, protection/indépendance de la clé non démontrées, aucune autorisation de signature |
| Installation, déploiement, fusion, qualification physique | **NO-GO**, non autorisés et stabilité réelle non démontrée |

Prochaine étape unique proposée : **faire examiner et approuver le protocole
d'horodatage issu de cette preuve, sans l'exécuter sur GPUbnb**. Cette revue doit
conserver les barrières de provenance, TLS, chaîne TSA, identité primaire et
vérification Windows finale. Elle n'autorise ni clé, ni signature, ni machine,
ni déploiement. L'approbation du fournisseur et la sécurisation d'un poste de
signature indépendant restent nécessaires avant toute demande d'exécution.
