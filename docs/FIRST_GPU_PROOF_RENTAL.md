# Premi?re location GPU Proof

Le parcours `GPU_PROOF` ex?cute une charge CUDA born?e dans un conteneur isol?. Il ne donne pas de shell au locataire et ne monte aucun fichier de l'h?te.

## Pr?requis h?te

- Docker avec NVIDIA Container Toolkit ;
- un GPU NVIDIA sain et suffisamment refroidi ;
- l'agent GPUbnb li? ? une machine disponible ;
- l'escrow Solana d?ploy? et configur? sur Devnet ;
- l'image publi?e par le workflow `GPU Proof workspace image`.

## Installer l'image immuable

Le workflow fournit le digest apr?s construction et signature. Sur l'h?te GPU, remplacez `<digest>` par cette valeur :

```powershell
gpubnb-agent workspaces install compute ghcr.io/khemisset18/gpu-proof-workspace@sha256:<digest>
gpubnb-agent protections verify
```

L'agent refuse une image hors de l'espace officiel ou non ?pingl?e par digest.

## Ex?cuter la premi?re preuve

1. Publier une annonce Devnet pour la machine.
2. Depuis l'interface, choisir `Lancer un GPU Proof ? 5 min`.
3. Signer le d?p?t d'escrow dans Phantom.
4. Laisser l'agent r?clamer et ex?cuter le job automatiquement.
5. V?rifier dans la session le GPU d?tect?, la dur?e, les it?rations et la suppression du conteneur.

Le succ?s exige des m?triques d'usage sign?es, un GPU CUDA d?tect? et `containerCleaned=true`. Un arr?t demand? ou une erreur ne valide pas la location.

## Contr?le avant production

Restez sur Devnet jusqu'? validation d'une location compl?te. Ne lancez pas la preuve si le GPU surchauffe : corrigez d'abord le refroidissement et confirmez la stabilit? avec les outils du constructeur.
