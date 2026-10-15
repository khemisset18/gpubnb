# GPUbnb Stage 4 — audit navigateur et fabrication éditeur, 15 octobre 2026

Décision : **GO audit/préparation ; NO-GO signature, installation, déploiement,
fusion et qualification physique**. Budget supplémentaire : **0 €**. Aucune
clé, création de certificat, intervention PC1/PC2 ou modification de service.

## Architecture retenue

| Emplacement | Responsabilité |
| --- | --- |
| PC1 | Hôte Windows NVIDIA, Agent, helper, worker, DLL média, affichage virtuel et session locataire isolée |
| Render | API, authentification, réservations, leases, gateway, suspension et facturation |
| PC2 | Navigateur exclusivement ; aucune installation GPUbnb, aucune extension obligatoire, aucune clé de signature |
| Éditeur | Construction et future signature dans un environnement distinct de PC1 et PC2 ; aucun environnement de signature approuvé confirmé actuellement |

La proposition antérieure de signature/TPM sur PC2 est abandonnée. La session
Windows locataire à isoler est sur PC1. Le navigateur de PC2 ne doit jamais être
transformé en poste de signature pour rendre GPUbnb utilisable.

## Périmètre réellement vérifié

- Sources du candidat `d21af2fbf1f110dff5c0cab7a460035fb2ddefa6` : client Web,
  authentification, catalogue/réservation, tableau de bord, gateway, politique
  d'accès, parcours privé, financement bêta, scripts et workflows de construction.
- Lecture HTTP **GET seulement, sans cookie ni connexion** de
  `https://gpubnb.netlify.app` et `https://gpubnb-stage3-private.onrender.com`.
- Métadonnées publiques de configuration relevées sous forme de présence et
  d'empreintes : aucune valeur de jeton ou de clé publiée dans le dossier.
- Métadonnées Render lues via le connecteur : service privé, branche et dernier
  déploiement. Aucun accès aux variables secrètes, aucun changement.
- Sept observations reproduites dans Node VM sur le code du dépôt, puis sept
  sur une copie du JavaScript réellement livré par Render. Tous les `fetch`
  de ces exécutions sont simulés. Aucun navigateur physique, utilisateur réel,
  financement, réservation, lease ou session n'est créé par les sondes.

Il s'agit d'un audit du chemin exécutable et des surfaces publiées, pas d'une
nouvelle validation de connexion Google/e-mail ou d'une session réelle. Les
anciens diagnostics TLS, WebSocket et TCP n'ont pas été relancés.

## Parcours utilisateur : ce qui fonctionne et ce qui est imposé

| Étape | Constat démontré | Logiciel/extension ou limite |
| --- | --- | --- |
| Arrivée sur le site | Le portail public et les pages de connexion répondent HTTP 200 ; les cartes renvoient vers `choose-workspace.html?listing=…` | Navigateur, JavaScript et HTTPS ; pas d'Agent client |
| Connexion | `auth.js` propose Google et e-mail/mot de passe ; échange serveur puis cookie GPUbnb. Phantom est une option distincte | Pas d'extension nécessaire pour les chemins Google/e-mail ; configuration publique présente, mais connexion réelle et configuration complète des fournisseurs non testées |
| Choix avec cookie GPUbnb valide | `/auth/me` puis réservation et préparation fonctionnent dans la simulation sans `window.solana` | Aucun portefeuille exigé par ce chemin frontend |
| Choix sans session | Après HTTP 401, `authenticate()` bascule sur Phantom et affiche « installez Phantom » si absent | **Défaut du parcours sans extension** ; l'utilisateur peut se connecter ailleurs, mais cette branche ne le guide pas vers la connexion Web |
| Erreur de service | Même bascule Phantom après HTTP 500 de `/auth/me` | Erreur API masquée par une demande de portefeuille ; ce n'est pas un remède au défaut réseau |
| Tableau de bord locataire | `nextStep()` propose « Activer l'espace propriétaire » à un compte `canRent=true, canHost=false` | **Guidage incorrect**, pas obligation backend d'installer le Host |
| Compte à deux rôles sans hôte | Le tableau de bord privilégie `host-install.html` | L'installation concerne le rôle hôte ; elle ne doit pas être présentée comme préalable à la location sur PC2 |
| Retour après connexion | `safeNext()` rejette `choose-workspace.html?listing=…` et renvoie au tableau de bord | L'intention de réservation est perdue ; conserver une allowlist sûre reste obligatoire |
| Financement public SOL | `payment-intent` et `confirm-deposit` exigent un portefeuille Solana valide et une transaction vérifiée. Le compte e-mail est représenté par `supabase:<id>` | **Parcours public sans portefeuille non démontré**. Le front actuel ne raccorde pas ces deux endpoints dans les fichiers Web inspectés. Ne supprimer aucun contrôle financier pour le rendre utilisable |
| Qualification privée | La page `stage3-windows-native.html` orchestre compte, réservation privée, attente de financement, préparation, `canOpen`, puis accès authentifié | Aucun portefeuille ni installation demandé par son JavaScript ; backend privé et éligibilité réelle restent indispensables |
| Bureau Windows | Page HTML, WebSocket de même origine, WebCodecs H.264, canvas et événements clavier/souris | Navigateur compatible WebCodecs/H.264 ; aucun helper, pilote, certificat, accès TPM ou service local côté PC2 |

Le portail public et Render servent encore le message Phantom dans le choix du
workspace. Le `authenticate()` Phantom de `app.js` existe aussi, mais n'est pas
appelé par le chemin de chargement/choix de carte inspecté : il ne constitue pas
une obligation universelle de la page d'accueil. Le bouton Phantom de la page
de connexion est optionnel. Les textes « transaction Phantom » de la timeline
doivent être distingués de la demande réellement exécutée.

La page privée fonctionne en simulation avec un cookie existant. Si le compte
n'est pas connecté, elle affiche actuellement une erreur plutôt que de fournir
le retour automatique vers la connexion ; elle n'installe pas de portefeuille.

Le financement privé est un mécanisme bêta déjà existant. Son serveur exige
`BETA_TEST_DEV_BYPASS=true` **et** l'escrow non déployé. Le réconciliateur gère
la transition de financement ; leases, allocations, fencing, contrôle de l'hôte
et comptabilité restent applicables. L'audit ne change ni n'active ces flags et
ne recommande aucune modification de la facturation. Ce mécanisme privé ne
démontre pas un paiement public SOL sans portefeuille.

## Preuves reproductibles

Exécuter depuis le checkout du dépôt, sans dépendance supplémentaire :

```sh
node --check docs/operations/stage4-browser-publisher-audit-20261015/browser-path-audit.mjs
node docs/operations/stage4-browser-publisher-audit-20261015/browser-path-audit.mjs
```

Les sept observations attendues ont été obtenues sur le dépôt et sur le code
livré. La sortie distingue les branches compatibles et les écarts observés.
Un résultat de reproduction réussi **ne signifie pas que le parcours est
conforme**. Ces sondes documentent les défauts ; elles ne sont pas une suite CI
qui figerait comme souhaitable le comportement incorrect.

`browser-path-evidence.json` et `delivered-private-browser-evidence.json`
contiennent les empreintes des sources réellement exécutées et les appels
simulés. Les deux fichiers HTTP décrivent seulement les GET et les métadonnées
publiques. Aucun identifiant de compte, mot de passe ou jeton n'est enregistré.

## État réel de Render et preuves déjà acquises

Service `srv-dau86i2d0e5s73elmk10`, `gpubnb-stage3-private`, branche
`qualification/stage3-windows-native-private-3c3e21e6` ; auto-deploy **no** et
previews **off**. Dernier déploiement live : `dep-db4j8gom7kps73c1u4p0`, commit
`6b655614d3b9c3fda7912742b539601ba22598f1`.

Le candidat gateway `0c901bbf67bf36098e54ddd01fce318beed867ae` n'y est donc pas
déployé. Le HTTP 200 de la page ne démontre ni l'application du correctif ws@7,
ni l'état d'une session, ni la stabilité vidéo. La réservation publique Windows
Native reste fermée ; les limites du provisioning Windows ne sont pas promues
par cette étude du navigateur.

Preuves réutilisées, sans nouvelle exécution :

- [PR #285](https://github.com/khemisset18/gpubnb/pull/285), brouillon, correctifs
  ws@7/TCP `fe0b1cde539abb71e289e1875b0cc9dc32f1629d` et leurs régressions.
- [CI d21af2fb, tentative 3](https://github.com/khemisset18/gpubnb/actions/runs/38670517761),
  six jobs réussis : API 805 réussis/2 ignorés, Agent 623 réussis/3 ignorés,
  build et TypeScript strict réussis.
- [Preuve HTTPS sécurisée](https://github.com/khemisset18/gpubnb/actions/runs/38670517814),
  quatre négatifs, cas positif Windows/SignTool et signataire principal conservé.
- Le dossier précédent conserve les manifests, SHA-256 et limites de cette preuve.

## Fabrication et signature côté éditeur à 0 €

### Disponible et démontré

La CI Windows hébergée construit et teste les composants indépendamment de
PC1/PC2. Le dépôt est public et les runners GitHub standard sont gratuits pour
ce type de dépôt, selon la
[documentation GitHub](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Ce constat ne vaut pas approbation d'un environnement de signature et n'inclut
aucun nouveau stockage payant, service managé ou runner premium.

Les workflows inspectés utilisent des runners hébergés. Le pipeline Host teste
l'Authenticode mais ne prouve pas une identité de signature provisionnée : la
mention de `sign-windows-authenticode.ps1` dans son filtre de chemins n'est pas
un appel de signature. Son mode Devnet éventuellement non signé ne doit jamais
être utilisé comme exception à la politique Stage 4.

Le script standard `sign-windows-authenticode.ps1` appelle actuellement SignTool
avec `/tr` ; il n'intègre pas le fork osslsigncode. La preuve HTTPS n'est donc
pas une chaîne de fabrication GPUbnb déjà livrée. Un futur point d'entrée de
qualification, à revoir et tester avant autorisation, devrait garder les copies
intermédiaires non horodatées hors distribution, ajouter le jeton RFC 3161 puis
exiger le vérificateur standard complet avant de produire le manifeste final.
Le script et la politique des releases publiques restent inchangés.

### Bloqué et non démontré

**Aucun environnement de signature autorisé et indépendant n'est confirmé dans
les preuves accessibles.** L'inventaire administratif des runners/environnements
GitHub n'est pas exposé par les endpoints publics autorisés du connecteur ; ce
refus ne prouve pas qu'il n'existe aucun poste ailleurs. Aucun secret n'a été
consulté pour chercher une clé.

La seule association de clé de qualification observée est sur PC1. Sa protection,
ses copies et l'accessibilité depuis la session locataire ne sont pas établies.
Son déplacement vers un autre endroit ne démontrerait pas l'absence de copies.
PC2 reste exclu de la fabrication et de la signature.

Le certificat épinglé `200208e0ef9dc3de4911df5541e6b11506c07de2820849006311cb68b342965a`
expire le **21 octobre 2026 à 00:23:47, heure de Paris**
(`2026-10-20T22:23:47Z`). Ni recul d'horloge, ni modification de ses dates,
ni horodatage postérieur ne sera présenté comme une prolongation de validité.
Un renouvellement produit un nouveau certificat feuille, donc un nouveau pin,
même s'il réutilise une clé. Une nouvelle clé évitant l'incertitude PC1 impose
une rotation de confiance explicite ; cette rotation n'est ni approuvée ni faite.

Une identité jetable générée dans un job éditeur pourrait faire l'objet d'une
conception ultérieure, mais elle ne réutilise pas le certificat existant, ne
préserve pas automatiquement les pins et n'est pas un environnement disponible
aujourd'hui. La CI de compilation et les attestations de provenance ne remplacent
ni Authenticode, ni la protection d'une clé, ni la confiance Windows.

### Ordre minimal futur, sous les autorisations nécessaires

1. Geler les commits et les preuves de CI déjà validés ; produire les artefacts
   AMD64 avec provenance et empreintes, sans installation côté locataire.
2. Avant signature, disposer d'une identité et d'un environnement éditeur
   réellement approuvés, avec clé inaccessible à PC1 et PC2. Sans cela : arrêt.
3. Vérifier le certificat exact, son EKU, ses dates et la politique de confiance.
   Toute rotation exige une approbation distincte avant modification des pins ou
   des magasins de confiance. Ne jamais accepter automatiquement un nouveau sujet.
4. Préparer un ensemble cohérent : DLL média signée -> worker avec son pin média
   et le commit attendu -> worker signé -> helper avec les pins worker/média ->
   helper signé. La portée minimale dépend de la conservation ou rotation de
   l'identité ; aucun remplacement de DLL/worker n'est décidé par défaut.
5. Ajouter l'horodatage via la méthode HTTPS auditée, après approbation du
   fournisseur. La compatibilité technique ai.moda/DigiCert déjà mesurée ne
   constitue pas cette approbation.
6. Vérifier sur un environnement distinct : Windows `Valid`, SignTool `/pa /all
   /v /tw`, identité primaire attendue, vérificateur standard avec signature et
   horodatage obligatoires ; publier un manifeste des SHA-256 **après** signature.
7. Seulement après accords distincts : déploiement Render privé du commit exact,
   installation hôte avec absence de session active et sauvegarde vérifiée,
   puis qualification PC1 -> navigateur PC2 pendant 300 secondes. Préserver les
   mécanismes de lease, isolation, suspension et facturation. Retour arrière vers
   les octets et le déploiement sauvegardés, avec arrêt si leur sécurité ne peut
   pas être confirmée ; ne pas présenter l'ancien gateway comme corrigé.

Le constructeur `build-windows-native-release-candidate.ps1` refuse explicitement
le certificat `LOCAL PHYSICAL TEST ONLY`. Il reste inchangé. Le candidat privé
doit utiliser sa procédure de qualification distincte approuvée, sans affaiblir
le constructeur public ni le vérificateur standard.

## Changements et décisions

Seuls ce dossier, la sonde d'audit et ses preuves sont ajoutés. Aucun fichier
applicatif, workflow, vérificateur, pin, politique de sécurité ou configuration
n'est modifié. La syntaxe Node de la sonde et les empreintes du dossier sont
contrôlées ; les deux exécutions de sept observations sont reproductibles.

| Objet | Décision |
| --- | --- |
| PC2 exclusivement navigateur | Confirmé comme contrat produit et périmètre technique |
| Parcours privé avec session existante, sans portefeuille | Compatible au niveau code/simulation ; non requalifié physiquement |
| Parcours public complet sans extension imposée | Non validé : repli Phantom, guidage locataire et financement public à traiter |
| Compilation éditeur à 0 € | Disponible sur la CI existante |
| Signature éditeur sûre avec identité actuelle | **NO-GO**, environnement et protection de clé non démontrés |
| Installation, déploiement, fusion, qualification physique | **NO-GO**, non autorisés |

**Prochaine action unique retenue : préparer une PR limitée au parcours
locataire navigateur**, avec tests : HTTP 401 -> connexion Web, erreur 500 ->
erreur de service, retour sûr au choix du GPU, et tableau de bord locataire ->
réservation plutôt qu'activation propriétaire. Périmètre :
`apps/web/choose-workspace.js`, `apps/web/auth.js`, `apps/web/portal.js` et tests
associés. Aucun changement de financement, de catalogue public Windows Native,
de sécurité ou de runtime média. Cette action améliore le parcours sans
prétendre résoudre le blocage indépendant de signature.
