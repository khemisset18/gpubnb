# Parcours professionnel GPUbnb Host

## Objectif produit

Une personne doit pouvoir télécharger GPUbnb Host, installer l’application, connecter son compte dans le navigateur, laisser l’application détecter automatiquement son GPU et publier une offre sans utiliser de terminal.

## Parcours cible

1. Télécharger un installateur correspondant au système.
2. Vérifier automatiquement l’intégrité et la signature de l’installateur.
3. Installer GPUbnb Host avec une explication claire de chaque privilège demandé.
4. Se connecter au site GPUbnb dans le navigateur avec un code temporaire à usage unique.
5. Détecter automatiquement le GPU, le pilote, Docker, le runtime NVIDIA et l’isolation matérielle.
6. Installer le service agent signé et le démarrer automatiquement.
7. Exécuter un diagnostic GPU officiel par digest immuable.
8. Afficher le modèle, la VRAM, l’état de sécurité et les éventuels correctifs nécessaires.
9. Configurer disponibilités et prix.
10. Publier le GPU uniquement lorsque tous les contrôles sont validés.

## Principes de sécurité

- Aucun mot de passe du site n’est saisi ou stocké dans l’application.
- L’association utilise un code temporaire et une clé d’installation locale.
- Un seul code d’association reste actif par compte Host.
- La génération d’un nouveau code invalide atomiquement le précédent.
- Les codes expirent après dix minutes, sont stockés sous forme de digest et sont consommés une seule fois.
- La clé privée de l’agent reste sur la machine et doit utiliser le coffre système quand disponible.
- Toute image distante est refusée si elle n’est pas épinglée par digest et issue du registre officiel.
- Le locataire n’accède jamais au bureau, aux dossiers personnels ou aux identifiants du propriétaire.
- L’activation est fail-closed : un contrôle inconnu, manquant ou incohérent bloque la publication.
- Un arrêt d’urgence local reste disponible en permanence.

## État de cette branche

Cette branche remplace le diagnostic natif fictif par des contrôles locaux réels :

- présence d’un GPU NVIDIA via `nvidia-smi` ;
- présence et accessibilité du démon Docker ;
- présence du runtime NVIDIA dans Docker ;
- présence de l’isolation matérielle adaptée au système ;
- compatibilité de l’OS et de l’architecture.

Elle ajoute également :

- une chaîne GitHub Actions multiplateforme qui construit des installateurs de développement pour Windows, Linux et macOS ;
- un manifeste SHA-256 et un avertissement interdisant de présenter ces artefacts non signés comme une version publique ;
- la génération manuelle d’un code depuis le tableau de bord Host ;
- le stockage serveur sous forme de digest uniquement ;
- l’invalidation atomique de l’ancien code ;
- la consommation unique du code côté agent ;
- des tests automatisés pour le remplacement, la concurrence, l’isolation des comptes et l’usage unique.

## Reste requis avant distribution publique

- intégration graphique complète de la saisie et de la confirmation du code dans Host Desktop ;
- signature Authenticode Windows ;
- notarisation et signature Apple Developer ID ;
- signature des paquets Linux et dépôt de paquets officiel ;
- mise à jour automatique signée avec rollback ;
- stockage de clé dans Windows Credential Manager, macOS Keychain et Secret Service Linux ;
- installation native et supervision du service agent ;
- écrans de prix, calendrier de disponibilité et publication de l’annonce ;
- tests physiques répétés sur plusieurs GPU NVIDIA.

## Critère d’acceptation

Le parcours est prêt pour un pilote lorsque, sur une machine propre, un utilisateur non technique peut terminer l’installation, voir son GPU détecté, connecter son compte, publier une annonce et recevoir un diagnostic de réservation sans ouvrir un terminal ni modifier manuellement un fichier de configuration.
