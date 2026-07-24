# GPUbnb Host Desktop — Actions requises du propriétaire

Status: **REQUIRED BEFORE OPERATIONAL USE**

Ce document sépare ce qui peut être développé dans le dépôt de ce qui doit être exécuté et vérifié physiquement sur de vraies machines.

## 1. Préparer une machine de développement propre

Installer sur une machine connectée à Internet :

- Git
- Node.js 22.12.0
- npm 10.9.0
- Rust 1.77.2
- les dépendances Tauri propres au système

Cloner puis sélectionner la branche :

```bash
git clone https://github.com/khemisset18/gpubnb.git
cd gpubnb
git checkout codex/host-desktop-foundation
```

## 2. Générer et commiter les lockfiles

Ces fichiers sont obligatoires pour une construction reproductible :

```bash
cd apps/host-desktop
npm install --ignore-scripts --no-audit --no-fund

cd src-tauri
cargo generate-lockfile
```

Vérifier que ces fichiers existent :

```text
apps/host-desktop/package-lock.json
apps/host-desktop/src-tauri/Cargo.lock
```

Puis :

```bash
git add apps/host-desktop/package-lock.json apps/host-desktop/src-tauri/Cargo.lock
git commit -m "build(host): commit reproducible dependency locks"
git push
```

## 3. Débloquer et vérifier GitHub Actions

Dans GitHub :

1. ouvrir l’onglet Actions ;
2. vérifier que les Actions sont autorisées pour le dépôt ;
3. résoudre tout blocage de facturation, quota ou compte ;
4. relancer le workflow `host-desktop` ;
5. ne pas fusionner tant que Windows, macOS et Linux ne sont pas verts.

Conserver les URLs et les identifiants des exécutions réussies comme preuves de validation.

## 4. Fournir de vraies machines de test

Au minimum :

- un PC Windows 11 Pro avec Hyper-V disponible ;
- une machine Linux récente avec KVM activé dans le BIOS/UEFI ;
- un Mac Apple Silicon récent pour Virtualization.framework ;
- une ou plusieurs cartes GPU réellement destinées au support initial.

Les machines de test ne doivent pas contenir de secrets personnels réels. Utiliser des comptes et documents factices conçus pour les tests d’isolation.

## 5. Activer la virtualisation matériellement

### Windows

- activer Intel VT-x/VT-d ou AMD-V/IOMMU dans le BIOS/UEFI ;
- activer Hyper-V ;
- redémarrer ;
- vérifier qu’une VM de test peut démarrer.

### Linux

- activer VT-x/AMD-V et IOMMU dans le BIOS/UEFI ;
- vérifier `/dev/kvm` ;
- vérifier les groupes IOMMU ;
- vérifier que QEMU/KVM peut lancer une VM sans privilèges excessifs.

### macOS

- utiliser un Mac compatible Virtualization.framework ;
- vérifier les limitations GPU du modèle exact ;
- ne pas annoncer une accélération GPU non réellement disponible dans la VM.

## 6. Choisir le périmètre matériel initial

Avant une version publique, décider et documenter :

- les modèles GPU supportés ;
- les versions minimales des pilotes ;
- les systèmes supportés ;
- les backends d’isolation officiellement certifiés ;
- les configurations explicitement refusées.

Commencer par un périmètre réduit est préférable à une compatibilité large non sécurisée.

## 7. Obtenir les certificats de signature

Actions commerciales et administratives nécessaires :

- certificat de signature de code Windows ;
- compte Apple Developer pour signature et notarisation macOS ;
- clé de signature protégée pour les paquets Linux ;
- stockage des clés dans un HSM, un service KMS ou un coffre CI sécurisé ;
- procédure de rotation et révocation en cas de compromission.

Aucune clé privée de signature ne doit être placée dans GitHub, dans le dépôt ou sur une machine personnelle non protégée.

## 8. Déployer une infrastructure GPUbnb réelle

Le produit complet nécessite également :

- un domaine HTTPS GPUbnb officiel ;
- une API d’authentification et de pairing ;
- une base de données ;
- un service de réservation ;
- une autorité d’identité machine ;
- un système de révocation des jetons ;
- une journalisation de sécurité ;
- une gestion des images de workspace signées ;
- une politique réseau et une liste de destinations autorisées.

Les domaines finaux doivent être ajoutés explicitement à la liste d’origines autorisées du client avant la construction de production.

## 9. Réaliser les tests physiques obligatoires

Sur chaque système supporté :

1. installer depuis un paquet signé ;
2. vérifier l’installation et la désinstallation du service ;
3. redémarrer la machine et vérifier la récupération d’état ;
4. démarrer puis arrêter le mineur ;
5. simuler un mineur bloqué ;
6. créer une location de test ;
7. vérifier que le workspace ne voit aucun fichier hôte ;
8. vérifier que le réseau local de l’hôte est inaccessible ;
9. déclencher l’arrêt d’urgence ;
10. couper brutalement le processus et redémarrer ;
11. vérifier la destruction du workspace et la révocation des identifiants ;
12. vérifier que le GPU revient dans un état connu et utilisable.

## 10. Faire réaliser une revue indépendante

Avant toute location réelle :

- revue du service privilégié ;
- revue de l’IPC local ;
- tests d’évasion de VM ou conteneur ;
- test d’accès aux dossiers personnels ;
- test de contournement du pare-feu ;
- test de rejeu et vol de jetons ;
- revue des installateurs et mises à jour ;
- correction de tous les problèmes critiques et élevés.

## 11. Condition de fusion

La PR ne doit être fusionnée que lorsque :

- les lockfiles sont commitées ;
- toute la CI est verte ;
- le service système existe réellement ;
- l’IPC est authentifié ;
- l’isolation fonctionne sur les systèmes annoncés ;
- le GPU est attribué et récupéré proprement ;
- le mineur est supervisé ;
- le pare-feu est appliqué ;
- les secrets utilisent les coffres natifs ;
- les installateurs sont signés ;
- les tests physiques et la revue indépendante sont terminés.

Jusqu’à cette validation, le logiciel reste une fondation de développement et ne doit pas accepter de locataires réels.
