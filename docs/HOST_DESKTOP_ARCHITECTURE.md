# GPUbnb Host Desktop — Architecture et expérience utilisateur

## Objectif produit

GPUbnb Host doit permettre à une personne non technique de partager la capacité de calcul compatible de son ordinateur sans exposer son bureau, ses documents, ses mots de passe ou son réseau local.

Le parcours normal doit rester compréhensible sans ligne de commande :

1. télécharger l’application adaptée au système ;
2. l’installer comme un logiciel classique ;
3. se connecter au compte GPUbnb ;
4. laisser l’application vérifier et protéger la machine ;
5. choisir les horaires, le prix et les limites ;
6. activer ou arrêter la disponibilité en un clic.

## Principes obligatoires

### 1. Sécurité fail-closed

Une machine n’est jamais publiée si une protection obligatoire est absente, inconnue ou en erreur. Le bouton d’activation reste bloqué jusqu’à validation complète.

### 2. Aucun accès direct au système personnel

Le locataire ne reçoit jamais une session sur le bureau de l’hôte. Il utilise exclusivement un workspace temporaire isolé.

Les dossiers personnels, disques externes, navigateurs, coffres de mots de passe, clés SSH et sessions utilisateur ne sont pas montés automatiquement.

### 3. Séparation des responsabilités

- **Interface Desktop** : non privilégiée, affiche l’état et recueille les choix de l’utilisateur.
- **Service GPUbnb Host** : service système signé, responsable des opérations privilégiées strictement autorisées.
- **Agent de télémétrie** : détecte le matériel et signe les preuves d’activité.
- **Runtime de workspace** : crée, supervise et détruit les environnements locataires.
- **API GPUbnb** : authentification, annonces, réservations, politiques et orchestration.

L’interface ne doit jamais exécuter directement une commande administrateur arbitraire.

## Architecture par système

### Windows

Ordre de préférence :

1. Hyper-V avec VM dédiée et GPU compatible ;
2. WSL2 avec runtime GPU lorsque le niveau d’isolation requis est atteint ;
3. machine déclarée incompatible si aucune solution certifiée n’est disponible.

Le service système utilise des ACL dédiées, un compte de service à privilèges minimaux et des règles de pare-feu limitées à la session.

### Linux

Ordre de préférence :

1. KVM/QEMU avec passthrough lorsque disponible ;
2. conteneur durci avec namespaces, cgroups, seccomp, AppArmor ou SELinux ;
3. machine déclarée incompatible si le noyau, le pilote ou le runtime ne permettent pas l’isolation minimale.

### macOS

Le runtime utilise la virtualisation native Apple lorsque compatible. Les capacités d’accès GPU doivent être annoncées honnêtement selon le modèle de Mac, l’architecture et les limitations du système.

Un Mac peut piloter un hôte distant même lorsqu’il ne peut pas proposer localement une accélération compatible.

## Cycle de vie d’une location

1. vérification de la réservation et de l’identité temporaire ;
2. nouvelle vérification de sécurité de la machine ;
3. création d’un workspace neuf ;
4. attribution des ressources CPU, RAM, disque, réseau et accélérateur ;
5. génération d’identifiants temporaires à durée de vie limitée ;
6. supervision et télémétrie signée pendant la session ;
7. arrêt immédiat en cas de perte de contrôle ou de violation de politique ;
8. révocation des accès ;
9. destruction du workspace ;
10. vérification du nettoyage avant remise en disponibilité.

## États utilisateur

L’application doit exposer des états simples et stables :

- **À configurer** : protections ou compte incomplets ;
- **Prêt** : machine vérifiée mais hors ligne ;
- **Disponible** : peut recevoir une location ;
- **Réservé** : prochaine session planifiée ;
- **En cours d’utilisation** : session active ;
- **En pause** : aucune nouvelle location ;
- **Action requise** : correction expliquée à l’utilisateur ;
- **Arrêt de sécurité** : session interrompue automatiquement.

Les détails techniques restent disponibles, mais ne doivent pas remplacer le message principal destiné au débutant.

## Règles d’interface pour débutants

- Une seule action principale par écran.
- Aucun terme technique sans explication en langage courant.
- Toute erreur indique : ce qui s’est passé, si le PC reste protégé et l’action à effectuer.
- Les choix risqués sont désactivés plutôt que simplement accompagnés d’un avertissement.
- Les réglages avancés sont séparés du parcours normal.
- Les montants, horaires, températures et limites utilisent les unités locales de manière cohérente.
- Les actions d’arrêt sont toujours visibles pendant une location.
- L’accessibilité clavier, le contraste, les libellés explicites et les lecteurs d’écran sont obligatoires.

## Données locales

Les secrets de machine sont stockés uniquement dans le mécanisme sécurisé du système :

- Windows Credential Manager ou DPAPI ;
- macOS Keychain ;
- Linux Secret Service ou stockage chiffré avec permissions strictes.

Les journaux excluent les clés privées, jetons complets, chemins personnels inutiles et contenu des fichiers utilisateur.

## Mises à jour et distribution

Les binaires publics doivent être reproductibles autant que possible, signés et publiés par pipeline CI :

- Windows : MSI et installateur signé ;
- macOS : DMG ou PKG signé et notarized ;
- Linux : AppImage, DEB et RPM selon support ;
- sommes SHA-256 publiées ;
- canal stable distinct des versions de test ;
- mise à jour automatique avec vérification cryptographique et possibilité de revenir à une version sûre.

## Critères avant fusion production

- compilation Windows, macOS et Linux ;
- tests unitaires du modèle d’état ;
- tests d’intégration du service et de l’agent ;
- tests de destruction du workspace ;
- vérification qu’aucun dossier personnel n’est monté ;
- test d’arrêt d’urgence ;
- audit des permissions Tauri ;
- signature des artefacts ;
- test utilisateur débutant documenté ;
- revue de sécurité indépendante avant une diffusion publique avec accès distant réel.
