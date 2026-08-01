# GPUbnb Host — durcissement avant installation

> Principe produit : **Ne jamais laisser un GPU ne rien faire.**

Ce document définit le chantier qui transforme le runtime technique actuel en une application réellement installable et exploitable sur un PC utilisateur.

## Règles de livraison

- `main` reste stable.
- Tous les changements passent par `feature/installable-host-hardening`.
- Aucun faux succès : une capacité absente doit être affichée comme bloquante.
- Aucun secret brut dans les fichiers, journaux, événements ou réponses frontend.
- Aucun binaire de minage n'est exécuté sans profil approuvé et vérification d'intégrité.
- Aucune fusion avant CI verte et validation matérielle documentée.

## P0 — fondations installables

1. Persistance atomique et versionnée de la configuration non sensible.
2. Validation du fichier au chargement et quarantaine des données corrompues.
3. Suppression des paniques dans les chemins utilisateur.
4. Identité d'installation persistante et obligatoire pour les opérations sensibles.
5. Journaux locaux structurés, rotation et export de diagnostic.

## P1 — secrets et premier lancement

1. Interface de coffre système unique.
2. Windows Credential Manager, macOS Keychain et Linux Secret Service.
3. Assistant de premier lancement reprenable.
4. Association durable machine/compte avec révocation.
5. Catalogue d'erreurs stable, messages compréhensibles et actions de réparation.

## P2 — mineur réel et sûreté

1. Manifeste de profils approuvés, versions épinglées et sommes de contrôle.
2. Installation explicite avec consentement et provenance vérifiable.
3. Arguments structurés sans shell ni concaténation de commande.
4. Supervision du processus, arrêt vérifié, timeout et quarantaine.
5. Reprise après crash ou redémarrage sans démarrage dangereux.

## P3 — packaging et expérience utilisateur

1. Installation et désinstallation propres du desktop, de l'agent et des sidecars.
2. Mise à jour atomique avec rollback.
3. Écran « Minage personnel » complet et accessible.
4. Diagnostic de compatibilité avant activation.
5. Validation sur Windows vierge puis sur matériel réel.

## Critères de sortie

- Configuration conservée après redémarrage de l'application et du système.
- Aucun secret exposé.
- Association du PC stable.
- Mineur approuvé démarré et arrêté de manière vérifiable.
- Préemption par une location couverte et testée.
- Installateurs Linux, macOS et Windows validés.
- CI entièrement verte.
- Rapport de test matériel joint à la PR.

Suivi : issue #41.
