# Première location GPU Proof

Le parcours `GPU_PROOF` exécute une charge CUDA bornée dans un conteneur isolé. Il ne donne pas de shell au locataire et ne monte aucun fichier de l'hôte.

## Prérequis hôte

- Docker avec NVIDIA Container Toolkit ;
- un GPU NVIDIA sain et suffisamment refroidi ;
- l'agent GPUbnb lié à une machine disponible ;
- l'escrow Solana déployé et configuré sur Devnet ;
- l'image publiée par le workflow `GPU Proof workspace image`.

## Installer l'image immuable

Le workflow fournit le digest après construction et signature. Sur l'hôte GPU, remplacez `<digest>` par cette valeur :

```powershell
gpubnb-agent workspaces install compute ghcr.io/khemisset18/gpu-proof-workspace@sha256:<digest>
gpubnb-agent protections verify
```

L'agent refuse une image hors de l'espace officiel ou non épinglée par digest.

## Exécuter la première preuve

1. Publier une annonce Devnet pour la machine.
2. Depuis l'interface, choisir `Lancer un GPU Proof · 5 min`.
3. Signer le dépôt d'escrow dans Phantom.
4. Laisser l'agent réclamer et exécuter le job automatiquement.
5. Vérifier dans la session le GPU détecté, la durée, les itérations et la suppression du conteneur.

Le succès exige des métriques d'usage signées, un GPU CUDA détecté et `containerCleaned=true`. Un arrêt demandé ou une erreur ne valide pas la location.

## Contrôle avant production

Restez sur Devnet jusqu'à validation d'une location complète. Ne lancez pas la preuve si le GPU surchauffe : corrigez d'abord le refroidissement et confirmez la stabilité avec les outils du constructeur.
