# GPUbnb Host — fondation durable

## Vision

GPUbnb Host doit rester simple pour l'utilisateur même si son architecture interne évolue pendant plusieurs années.

L'expérience cible est constante :

1. télécharger l'application officielle ;
2. installer sans terminal ;
3. connecter son compte dans le navigateur ;
4. laisser GPUbnb détecter et préparer la machine ;
5. choisir ses disponibilités ;
6. mettre le GPU en ligne ;
7. pouvoir tout arrêter immédiatement.

La simplicité de l'interface ne doit jamais masquer une incertitude de sécurité. Une opération non certifiée reste bloquée.

## Principes non négociables

### Sécurité fail-closed

- aucune location ne démarre si un contrôle obligatoire manque ;
- une valeur inconnue est considérée comme non sûre ;
- une perte de communication avec le service privilégié met la machine hors ligne ;
- un arrêt d'urgence ne peut pas être annulé sans nouvelle vérification ;
- aucun dossier personnel n'est monté implicitement.

### Interface non privilégiée

L'interface Tauri ne doit pas exécuter directement des commandes administrateur. Elle demande une opération métier précise au service GPUbnb Host.

Exemples autorisés :

- installer le service signé ;
- vérifier la virtualisation ;
- créer un workspace avec une politique donnée ;
- détruire un workspace identifié ;
- arrêter une session.

Exemples interdits :

- exécuter une chaîne de commande arbitraire ;
- transmettre un chemin utilisateur non validé ;
- ouvrir un shell ;
- accepter une URL ou un binaire non signé comme source d'installation.

### Contrats versionnés

Chaque échange entre l'interface, le service local et l'API doit inclure une version de contrat.

Les évolutions suivent ces règles :

- ajout de champ : compatible avec les anciennes versions ;
- suppression ou changement de sens : nouvelle version majeure ;
- valeur inconnue : refus sécurisé ou comportement explicitement documenté ;
- période de transition : au moins une version stable lorsque cela est possible.

### Données locales migrables

Les préférences non sensibles peuvent être stockées localement avec :

- un numéro de version de schéma ;
- des migrations déterministes ;
- une sauvegarde avant migration ;
- un retour aux valeurs sûres si la migration échoue.

Les secrets ne sont jamais enregistrés dans ce fichier. Ils utilisent le coffre natif du système.

## Découpage durable

### Interface produit

Responsabilités :

- assistant de première utilisation ;
- explications simples ;
- tableau de bord ;
- disponibilités et prix ;
- affichage des diagnostics ;
- arrêt d'urgence.

Elle ne décide jamais seule qu'une protection est valide.

### Cœur métier Rust

Responsabilités :

- machine d'états ;
- règles de readiness ;
- validation des commandes IPC ;
- traduction des diagnostics en actions utilisateur ;
- maintien des invariants fail-closed.

### Service système signé

Responsabilités :

- opérations administrateur ;
- gestion du runtime isolé ;
- pare-feu de session ;
- supervision du GPU ;
- création et destruction des workspaces ;
- preuve d'intégrité et journal d'audit.

### Adaptateurs par plateforme

Les détails Windows, macOS et Linux sont derrière des interfaces stables.

- Windows : Hyper-V ou autre backend certifié ;
- macOS : Virtualization Framework ;
- Linux : KVM ou backend certifié.

Le moteur peut évoluer sans modifier le parcours utilisateur ni les règles métier.

## Assistant de première utilisation

L'assistant est une machine d'états, pas une suite de pages indépendantes.

États prévus :

1. `welcome` ;
2. `account_pairing` ;
3. `hardware_detection` ;
4. `service_installation` ;
5. `isolation_certification` ;
6. `availability_setup` ;
7. `ready_to_publish` ;
8. `dashboard` ;
9. `recovery_required`.

Chaque état expose :

- un titre simple ;
- une explication courte ;
- une seule action principale ;
- la raison exacte d'un blocage ;
- une action de récupération ;
- un identifiant stable pour la télémétrie sans données personnelles.

La progression sauvegardée n'est qu'un confort d'affichage. Au redémarrage, toutes les protections système sont revérifiées.

## Mises à jour

Une mise à jour doit être :

- signée ;
- vérifiée avant installation ;
- atomique lorsque la plateforme le permet ;
- réversible si le démarrage suivant échoue ;
- compatible avec la version du service local ;
- incapable de remettre automatiquement une machine en ligne après une migration risquée.

Le canal stable ne reçoit pas une version tant que les installateurs des trois plateformes, les migrations et les contrôles de sécurité ne sont pas validés.

## Observabilité respectueuse

Les journaux locaux doivent aider au support sans contenir :

- mot de passe ;
- jeton complet ;
- contenu de fichier utilisateur ;
- chemin personnel non anonymisé ;
- code d'association réutilisable.

Les événements importants utilisent des identifiants structurés, par exemple :

- `pairing_started` ;
- `service_installation_requested` ;
- `isolation_check_failed` ;
- `workspace_destroyed` ;
- `emergency_stop_activated`.

## Définition de terminé

Une fonctionnalité n'est terminée que si :

- elle fonctionne réellement sur les plateformes annoncées ;
- elle est testée ;
- son échec est compréhensible par un débutant ;
- son comportement de sécurité est documenté ;
- elle ne nécessite pas de terminal dans le parcours normal ;
- elle possède une stratégie de migration ou de compatibilité ;
- elle est observable sans exposer de secret.

## Priorités de réalisation

1. remettre toutes les CI au vert ;
2. versionner les contrats frontend/backend ;
3. créer l'assistant d'installation comme machine d'états ;
4. intégrer la détection matérielle native ;
5. construire le service système signé ;
6. intégrer le coffre de secrets natif ;
7. certifier le provisioning et la destruction des workspaces ;
8. créer les installateurs signés et les mises à jour atomiques ;
9. effectuer des tests utilisateurs débutants et des audits de sécurité.

Cette architecture permet de faire évoluer les moteurs techniques sans casser la promesse produit : une installation simple, une protection explicite et un contrôle total pour l'hôte.
