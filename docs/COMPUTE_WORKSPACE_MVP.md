# Compute Workspace MVP

## Ce qui est livré

Le premier environnement GPUbnb est `Compute`. Une réservation financée peut créer une `WorkspaceSession`, la démarrer, consulter ses métriques et demander son arrêt. Le propriétaire de la machine dispose du même arrêt d'urgence.

La confirmation du dépôt crée désormais automatiquement la session et une commande `WORKSPACE_PREPARE`. L'agent la récupère sans attendre l'arrivée du locataire, vérifie le cache Docker, télécharge réellement l'image épinglée si elle manque, lance le diagnostic GPU isolé puis transmet son résultat. La session reste `PREPARING` et inaccessible jusqu'à la réussite du contrôle, puis passe à `READY`.

Au moment de l'entrée, l'API vérifie encore que la réservation a commencé, que l'agent a envoyé un heartbeat récent et que la machine est disponible. Une préparation ancienne ne suffit donc pas à ouvrir l'accès si la machine est devenue hors ligne.

GPUbnb Agent est le logiciel installé chez le loueur. Il authentifie la machine par signature Ed25519, exécute uniquement le diagnostic GPU autorisé et publie une mesure liée à la session. Le locataire n'obtient ni session Windows, ni accès SSH, ni accès au réseau local ou aux fichiers personnels.

## Isolation et limites

La session déclare une isolation Docker, un réseau désactivé, 1 cœur CPU, 512 MiB de RAM, 1 GiB de stockage et une expiration de dix minutes maximum. Ces valeurs constituent le contrat de session enregistré par l'API.

L'exécution réelle actuelle reste le conteneur de diagnostic épinglé par digest déjà utilisé par l'agent. La création d'un environnement interactif général, l'installateur Windows signé, le service système permanent et une collecte continue de métriques sont les prochaines étapes avant une commercialisation réelle.

## Mesures et rémunération

Chaque mesure contient un compteur monotone, une date récente, l'utilisation GPU/VRAM/CPU/RAM/disque/réseau, la disponibilité et une preuve de charge. L'API refuse les compteurs rejoués, les dates anciennes et les valeurs dépassant la mémoire déclarée.

Une seconde n'est ajoutée à `Booking.validSeconds` que si la machine est disponible et que la preuve de charge est présente. Le cumul est plafonné à `expectedSeconds`. Le règlement existant peut ensuite calculer le paiement au prorata des secondes validées.

## Limite de sécurité importante

Ce MVP est une fondation testable, pas encore un hyperviseur certifié. Avant de permettre des charges arbitraires, il faudra ajouter une sandbox OS renforcée (VM ou microVM), des profils seccomp/AppArmor, une politique egress, un stockage éphémère chiffré, un effacement vérifié, une signature du corps des mesures et des audits de sécurité sur deux machines physiques.
