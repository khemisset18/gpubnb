# Installer GPUbnb Host

GPUbnb Host doit être simple à installer, même pour une personne qui n’a jamais utilisé un terminal.

## Parcours utilisateur cible

1. Télécharger l’installateur correspondant à Windows, macOS ou Linux.
2. Ouvrir l’installateur et suivre les explications affichées.
3. Lancer GPUbnb Host depuis l’icône du bureau ou le menu des applications.
4. Connecter son compte dans le navigateur.
5. Autoriser l’installation du service GPUbnb lorsque le système le demande.
6. Laisser l’application vérifier automatiquement le GPU et les protections.
7. Choisir ses disponibilités et son prix.
8. Mettre le GPU en ligne.

Aucune commande manuelle ne doit être nécessaire dans le parcours normal.

## Connexion au compte

L’application ne collecte et ne conserve jamais le mot de passe GPUbnb.

La connexion suit un modèle d’association d’appareil :

1. GPUbnb Host demande un code temporaire au service GPUbnb.
2. L’utilisateur ouvre le site GPUbnb dans son navigateur habituel.
3. Il se connecte sur le site et confirme l’ordinateur.
4. Le service renvoie à l’application un jeton limité à cet appareil.
5. Le jeton est stocké dans le coffre natif du système d’exploitation.

Le code temporaire doit expirer rapidement et ne doit être utilisable qu’une seule fois.

## Configuration de développement

La variable de compilation suivante configure l’origine du site officiel :

```text
GPUBNB_WEB_BASE_URL=https://app.example.com
```

Seules les origines HTTPS simples sont acceptées. Les chemins, informations utilisateur, fragments et URL HTTP sont refusés.

La page d’association utilisée est :

```text
/host/pair
```

Si cette variable n’est pas définie ou si sa valeur est invalide, GPUbnb Host bloque la connexion au compte. Il ne simule jamais une association réussie.

## Installation du service système

Le service privilégié doit être séparé de l’interface graphique.

Il sera responsable uniquement des opérations qui nécessitent des droits élevés :

- diagnostic matériel approfondi ;
- configuration du moteur d’isolation ;
- création et destruction des environnements locataires ;
- règles réseau temporaires ;
- arrêt d’urgence ;
- nettoyage après une location.

L’interface utilisateur ne doit jamais exécuter directement une commande arbitraire avec les droits administrateur.

## Règles de sécurité obligatoires

- aucun partage automatique du dossier personnel ;
- aucun mot de passe dans les journaux ou fichiers de configuration ;
- aucune activation si un contrôle obligatoire échoue ;
- aucune fausse réussite lorsque le backend est indisponible ;
- toute URL externe doit être validée avant affichage ou ouverture ;
- les jetons doivent être stockés dans le coffre natif du système ;
- l’environnement locataire doit être détruit après chaque session.

## État actuel

L’interface guidée, le contrat d’association et les contrôles fail-closed sont en place.

Le service d’association distant, le coffre de secrets natif, le service système signé et les installateurs signés restent à connecter avant une publication publique.
