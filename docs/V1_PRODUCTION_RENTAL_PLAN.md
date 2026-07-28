# GPUbnb v1 — parcours de location réellement fonctionnel

Cette branche ne doit pas être fusionnée dans `main` tant que le parcours complet n'est pas démontré sur une vraie machine Windows équipée d'un GPU.

## Parcours utilisateur cible

1. Le propriétaire installe GPUbnb Host.
2. Il clique sur **Se connecter**.
3. GPUbnb Host ouvre une page d'autorisation dédiée sur le site.
4. L'utilisateur se connecte avec Supabase/Google/email dans le navigateur.
5. Le site demande explicitement l'autorisation de relier cet ordinateur.
6. L'application récupère automatiquement une autorisation à usage unique via un protocole de device authorization. Le code manuel reste seulement un secours.
7. GPUbnb Host génère et conserve une clé d'appareil, enregistre la machine via `/agent/link`, puis persiste l'identifiant de machine.
8. L'agent démarre en arrière-plan, détecte le matériel et envoie des heartbeats signés.
9. Le site affiche la machine, son GPU, son état et son dernier heartbeat.
10. Le propriétaire ouvre la fiche de la machine sur le site, choisit prix, disponibilités et conditions, puis publie l'annonce.
11. Un locataire réserve et finance la session de test.
12. L'API crée les jobs nécessaires, l'agent prépare l'environnement isolé et exécute le workload autorisé.
13. Les métriques sont envoyées pendant la session.
14. À la fin, le workload s'arrête, l'espace temporaire est détruit et la réservation est clôturée.

## Contrat de connexion Host ↔ site

Le parcours principal doit utiliser un protocole de type OAuth Device Authorization :

- l'application crée une demande d'association contenant une clé publique et une empreinte de machine ;
- l'API renvoie un identifiant opaque, une URL de vérification et une expiration courte ;
- le navigateur ouvre cette URL ;
- l'utilisateur authentifié autorise la machine ;
- l'application interroge périodiquement l'état de la demande ;
- après autorisation, l'API consomme la demande une seule fois et crée ou retourne la machine ;
- aucun mot de passe, cookie de session web ou jeton Supabase n'est transmis à l'application ;
- le code de liaison manuel actuel reste disponible comme solution de secours.

## Lots de travail

### Lot A — connexion et persistance

- [ ] Routes API de création, autorisation, lecture et consommation d'une demande d'association.
- [ ] Validation d'origine, expiration, consommation unique et limitation de débit.
- [ ] Page web dédiée à l'autorisation d'une machine.
- [ ] Ouverture du navigateur depuis Tauri avec le plugin officiel shell/opener.
- [ ] Polling sécurisé depuis GPUbnb Host.
- [ ] Stockage persistant de l'identifiant machine et de la clé privée dans le coffre natif.
- [ ] État « compte connecté » fondé sur la persistance réelle, jamais sur une valeur en mémoire.

### Lot B — agent intégré

- [ ] Réutiliser le protocole signé déjà présent dans `agent/gpubnb_agent`.
- [ ] Installer l'agent sans terminal.
- [ ] Démarrer et surveiller le heartbeat en arrière-plan.
- [ ] Afficher les erreurs réelles : pilote absent, GPU absent, API inaccessible, clé révoquée.
- [ ] Synchroniser l'état Host desktop avec `/machines/mine` et le dernier heartbeat.

### Lot C — publication de l'annonce

- [ ] Ouvrir directement la page de la machine liée.
- [ ] Préremplir les caractéristiques détectées sans permettre de les falsifier.
- [ ] Définir prix, disponibilités, durée minimale/maximale et politique d'annulation.
- [ ] Interdire l'activation si la machine n'est pas en ligne, vérifiée ou compatible.
- [ ] Vérifier que les routes `/listings` et les vues publiques utilisent la même source de vérité.

### Lot D — réservation et exécution

- [ ] Vérifier toutes les transitions de réservation et de paiement.
- [ ] Vérifier la création et la consommation des jobs agent.
- [ ] Préparer un workspace isolé autorisé.
- [ ] Démarrer, surveiller puis arrêter le workload.
- [ ] Envoyer les métriques et preuves d'activité.
- [ ] Nettoyer systématiquement les fichiers, conteneurs, règles réseau et secrets temporaires.
- [ ] Tester les échecs : agent hors ligne, GPU modifié, heartbeat perdu, paiement expiré, arrêt d'urgence.

### Lot E — Windows et release

- [ ] Installateur unique avec agent et dépendances nécessaires.
- [ ] Démarrage automatique et désinstallation propre.
- [ ] Journaux et diagnostic exportables sans secrets.
- [ ] Mise à jour contrôlée.
- [ ] Workflow de release stable séparé du canal de test.
- [ ] Signature Windows activable par secrets CI lorsque le certificat sera disponible.

## Audit initial des routes existantes

Le dépôt possède déjà les briques suivantes :

- authentification Supabase et session web : `/auth/supabase`, `/auth/me` ;
- génération du code manuel : `/machines/link-code` ;
- consommation du code par l'agent : `/agent/link` ;
- inventaire des machines du propriétaire : `/machines/mine` ;
- challenges et heartbeats signés : `/agent/challenge/:machineId`, `/agent/heartbeat` ;
- création d'annonces : `/listings` ;
- catalogue de workspaces et analyse de compatibilité ;
- file de jobs agent et métriques de session dans le client Python.

Le principal manque du parcours de connexion est le retour automatique site → application et la persistance réelle dans GPUbnb Host. Le principal manque de production est que plusieurs actions du desktop retournent encore `automatic_setup_pending` au lieu d'exécuter une installation ou une vérification réelle.

## Conditions obligatoires de fusion dans `main`

La branche ne sera fusionnée que lorsque toutes ces preuves existent :

- [ ] CI TypeScript, Rust, Python et migrations verte.
- [ ] Tests automatisés de sécurité du protocole d'association.
- [ ] Test automatisé API : autorisation → liaison → heartbeat → annonce.
- [ ] Test réel Windows : installation sur machine propre.
- [ ] Connexion navigateur avec retour automatique dans Host.
- [ ] Machine visible sur le site avec les bonnes caractéristiques.
- [ ] Annonce publiée avec prix et disponibilités.
- [ ] Réservation de test complète avec un workload GPU réel.
- [ ] Arrêt et nettoyage vérifiés après la réservation.
- [ ] Aucun bouton de production ne retourne une réussite simulée.
- [ ] Rapport de test joint à la PR avec captures, identifiants anonymisés et journaux expurgés.

Tant que ces conditions ne sont pas remplies, la PR reste en brouillon et `main` n'est pas modifiée.