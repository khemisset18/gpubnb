# Architecture du minage optionnel GPUbnb

## Statut et principe produit

Le produit principal de GPUbnb reste la location de ressources de calcul. Le minage est une activité optionnelle utilisée uniquement lorsque la ressource n'est pas louée.

Principes non négociables :

- la location est toujours prioritaire ;
- le minage est désactivé par défaut ;
- l'autorisation de miner et la reprise automatique après location sont deux choix distincts ;
- `autoResumeAfterRental` vaut `false` par défaut dans le desktop, Prisma et PostgreSQL ;
- aucun appel administrateur, locataire ou contrôle distant ne peut activer silencieusement le minage ;
- CPU et GPU sont gérés comme des ressources indépendantes ;
- louer un GPU ne doit pas interrompre les autres GPU ni le CPU, sauf location explicitement exclusive de toute la machine.

## Modes de minage

Chaque ressource CPU ou GPU possède une configuration indépendante :

1. `DISABLED` : aucun minage hors location ;
2. `GPUBNB_MANAGED` : utilisation d'un profil approuvé et du pool géré GPUbnb, avec 100 points de base, soit 1 %, de frais de plateforme ;
3. `OWNER_POOL` : utilisation du pool personnel du propriétaire, avec 0 % de frais GPUbnb.

Les calculs monétaires futurs doivent utiliser des unités atomiques entières et conserver l'invariant :

`ownerAmount + platformAmount = grossAmount`

GPUbnb ne doit pas conserver les clés privées des portefeuilles des propriétaires.

## Ressources persistées

La couche Prisma/PostgreSQL conserve notamment :

- `MiningResource` : ressource CPU ou GPU, état runtime, location active et quarantaine ;
- `MiningConfiguration` : mode, profil, wallet public, worker, limites matérielles et version optimiste ;
- `MiningRuntimeEvent` : journal idempotent des transitions envoyées par l'agent ;
- `MiningAuditLog` : historique des modifications de configuration ;
- `Machine.lastCounter` : compteur monotone durable utilisé contre les rejeux.

L'inventaire de l'agent synchronise séparément le CPU et chaque GPU à l'aide de clés de ressource stables.

## API propriétaire implémentée

Routes principales :

- `GET /machines/:machineId/mining-resources`
- `PUT /machines/:machineId/mining-resources/:resourceId/configuration`
- `POST /internal/mining/runtime-events`

Les routes propriétaire exigent une session valide et vérifient que la machine appartient à l'utilisateur.

Les modifications de configuration utilisent `expectedVersion`. Une mise à jour fondée sur une ancienne version est rejetée afin d'éviter l'écrasement concurrent de réglages récents.

Une configuration ne peut pas être activée sur une ressource en quarantaine ou actuellement louée.

## Priorité à la location et machine à états

États runtime persistés :

- `IDLE`
- `STARTING`
- `MINING`
- `PREEMPTING`
- `VERIFYING_STOP`
- `RENTAL_BLOCKED`
- `STOPPED`
- `QUARANTINED`
- `EMERGENCY_STOPPED`

Lorsqu'une location cible une ressource qui mine :

1. aucun nouveau démarrage de mineur n'est accepté ;
2. le processus de minage reçoit un ordre d'arrêt ;
3. le processus et ses enfants doivent être terminés ;
4. les handles GPU, conteneurs et fichiers temporaires doivent être libérés ;
5. l'utilisation et la température doivent revenir sous les seuils de sécurité ;
6. l'environnement de location est préparé seulement après confirmation de l'arrêt ;
7. un échec place la ressource en quarantaine et bloque son utilisation.

Après la location, le minage ne reprend que si :

- la ressource minait avant la réservation ;
- le nettoyage est confirmé ;
- la ressource est saine et non mise en quarantaine ;
- aucune nouvelle location n'est en attente ;
- le consentement minage est toujours actif ;
- `autoResumeAfterRental` a été explicitement activé.

## Catalogue contrôlé de mineurs

Le desktop n'accepte jamais une commande shell, un chemin d'exécutable ou des arguments arbitraires provenant de l'API.

Chaque profil approuvé doit définir :

- l'actif et l'algorithme ;
- la compatibilité CPU, NVIDIA ou AMD ;
- le binaire et sa version épinglée ;
- l'origine de téléchargement et le SHA-256 ;
- la licence et le droit de redistribution ;
- le modèle d'arguments autorisé ;
- les limites thermiques et électriques ;
- les protocoles Stratum acceptés ;
- une stratégie de retour arrière.

Un profil peut rester désactivé tant que les tests matériels, l'analyse antivirus et la revue de licence ne sont pas terminés.

## Pools personnels et références de secrets

Les endpoints de pool doivent utiliser explicitement :

- `stratum+tcp://`
- `stratum+ssl://`
- `stratum+tls://`

`ownerPoolSecretRef` ne peut pas contenir un mot de passe brut. Les préfixes de références autorisés sont :

- `vault://`
- `secret://`
- `aws-secretsmanager://`
- `gcp-secretmanager://`
- `azure-keyvault://`

La valeur désigne un secret dans un coffre externe. Elle n'est pas renvoyée par la route de liste des ressources.

Une migration PostgreSQL installe également un trigger défensif sur `MiningAuditLog`. Avant chaque insertion ou modification, la base supprime automatiquement `ownerPoolSecretRef` de `previousValue` et `nextValue`, même si une future route oublie de le masquer.

Avant une ouverture publique des pools personnalisés, compléter les protections réseau : résolution DNS contrôlée, défense contre le DNS rebinding, blocage des adresses loopback, link-local, privées de contrôle et des métadonnées cloud.

## Authentification Ed25519 V2 des événements runtime

`POST /internal/mining/runtime-events` utilise une signature propre à chaque machine.

La donnée signée contient :

`METHOD|PATH|machineId|timestamp|nonce|bodySha256`

Contrôles appliqués :

- version de signature `2` obligatoire ;
- clé publique Ed25519 associée à la machine ;
- vérification du SHA-256 du corps brut ;
- corps brut obligatoire, sans reconstruction JSON de secours ;
- fenêtre temporelle limitée ;
- nonce à usage unique enregistré dans Redis ;
- machine non révoquée et non mise en quarantaine ;
- ressource appartenant à la machine signataire ;
- `agentCounter` strictement positif et monotone ;
- mise à jour de `Machine.lastCounter` dans une transaction PostgreSQL `Serializable`.

Une signature invalide ou l'absence du corps brut est enregistrée comme incident de sécurité.

## Idempotence des événements

Chaque événement possède une `idempotencyKey`.

- Un événement déjà enregistré et strictement identique retourne `accepted: false` sans consommer de nouveau compteur.
- Une même clé utilisée avec un contenu différent est rejetée par `idempotency_key_collision`.
- Le compteur machine n'avance que pour un nouvel événement accepté.
- Un compteur inférieur ou égal au compteur durable est rejeté par `agent_counter_replay`.

Les événements ordinaires, notamment les heartbeats, ne peuvent pas effacer accidentellement une location active. Seuls les événements de libération et de nettoyage autorisés peuvent supprimer `activeRentalId`.

## Observabilité et audit

À collecter par ressource :

- identité du processus de minage ;
- profil, algorithme et version ;
- hashrate et shares acceptées, rejetées ou périmées ;
- température, hotspot et ventilateurs lorsque disponibles ;
- consommation et limite de puissance ;
- raison de démarrage ou d'arrêt ;
- dernière preuve de nettoyage ;
- latence de préemption avant location ;
- changements de configuration et acteur associé.

Ne jamais journaliser :

- mots de passe de pools ;
- clés privées ;
- jetons d'authentification ;
- commandes contenant des secrets ;
- contenu résolu des coffres de secrets.

## Composants futurs du pool géré

Le mode géré complet doit être séparé en services :

- catalogue de profils signé ;
- passerelle Stratum avec TLS et protection DDoS ;
- validation et comptabilisation idempotente des shares ;
- rapprochement des récompenses avec les pools en amont ;
- registre immuable propriétaire/plateforme ;
- moteur de paiement sans conservation de clés privées ;
- détection des abus, limites de débit et sanctions.

La présente PR fournit l'architecture de configuration, de runtime, de sécurité et de préemption. Elle ne constitue pas à elle seule un pool public complet ni un système de paiement en production.

## Validation continue

Les workflows concernés sont :

- `CI`
- `api-mining-ci`
- `deployment-readiness`
- `host-desktop`
- `host-desktop-dev-installers`
- `host-windows-preflight`

Ils vérifient notamment Prisma, les migrations PostgreSQL, TypeScript, les tests API, le build, Rustfmt, Clippy, les tests desktop et la création des installateurs.

## Critères avant activation publique

Même si le code peut être fusionné derrière des choix désactivés par défaut, l'activation publique du minage reste interdite tant que les éléments suivants ne sont pas validés :

- tests physiques NVIDIA et AMD pour chaque profil activé ;
- validation antivirus et licences des binaires distribués ;
- mesure de la préemption et du nettoyage sur machines réelles ;
- tests de température, puissance, crash et redémarrage ;
- audit SSRF et DNS rebinding des pools personnalisés ;
- stockage et rotation réels des secrets dans un coffre ;
- réconciliation exacte du pool géré et des frais 99 % / 1 % ;
- supervision, alertes, procédures d'incident et retour arrière ;
- revue juridique, fiscale, sanctions et information consommateur dans les pays de lancement.
