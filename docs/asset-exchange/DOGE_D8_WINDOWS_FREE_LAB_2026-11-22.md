# GPUbnb DOGE — Étape D8 gratuite depuis Windows

Ce parcours est adapté à l'utilisateur qui possède **un PC Windows et Trust Wallet**.
Aucun deuxième wallet ni matériel payant ne sont nécessaires pour **continuer
la validation logicielle**. Mais le D8 matériel H8.1–H8.5 reste bloqué tant
que ses preuves physiques ne sont pas réalisées.

## Contrôle Windows gratuit et non intrusif

Dans le dépôt GPUbnb, ouvrir **PowerShell classique**, sans droits administrateur
ni logiciel de portefeuille, puis exécuter :

```powershell
powershell -NoProfile -File .\asset-exchange\qualification\dogecoin\d8\d8-windows-readiness.ps1
```

Le programme observe seulement : build Windows, présence de `wsl.exe`,
existence d'au moins une distribution WSL2 affichée dans
`wsl --list --verbose`, et quand elles sont accessibles, les
informations générales de Defender et du pare-feu. Il ne stocke pas les
noms de distribution, d'utilisateur ou de machine, n'installe rien, ne démarre
aucun nœud, ne contacte aucun service, ne demande **aucune seed**, et
n'accède à aucun portefeuille ni transaction.

Le résultat indique `WINDOWS_SOFTWARE_LAB_PREREQUISITE_READY` ou
`WINDOWS_SOFTWARE_LAB_SETUP_REQUIRED`. Aucun de ces résultats ne
signifie D8 qualifié. Si le PC est prêt, une **seconde vérification**
indépendante doit encore prouver l'isolation réseau Linux effective
avant d'y exécuter Dogecoin Core.

Optionnel, pour écrire un fichier de résultat nouveau (ne remplace jamais
un fichier existant) :

```powershell
powershell -NoProfile -File .\asset-exchange\qualification\dogecoin\d8\d8-windows-readiness.ps1 -OutputFile .\d8-windows-local.json
```

Ne jamais publier ni envoyer de rapport système détaillé, de seed ou de clé privée.
Pour une demande d'assistance, communiquer seulement les six valeurs :
`windowsBuild`, `windowsBuildSupportsModernWSL`,
`wslCommandPresent`, `wslListingSucceeded`,
`wsl2DistributionListed`, `classification`.

Si WSL2 n'est pas installé, Microsoft décrit sa procédure officielle
([installation](https://learn.microsoft.com/fr-fr/windows/wsl/install),
[commandes](https://learn.microsoft.com/fr-fr/windows/wsl/basic-commands)).
**Le programme ne l'installe pas automatiquement**, car l'installation
demande une action explicite sur le PC, peut requérir l'administration et un
redémarrage.

## Preuves GitHub déjà obtenues sans manipuler le PC de l'utilisateur

- [GitHub #45064356615](https://github.com/khemisset18/gpubnb/actions/runs/45064356615) :
  financement HTLC privé, confirmations, refus pré-lock, remboursement signé,
  reprise après crash, retry et reorg, **PASS**, clés de test jetables
- [GitHub #45063733044](https://github.com/khemisset18/gpubnb/actions/runs/45063733044) :
  signature Ledger **émulée** vérifiée en Dogecoin Core natif sur un
  financement **fictif**, 1 signature acceptée et 11 mutations rejetées

Ce sont deux scénarios distincts. **Aucun n'a qualifié un wallet matériel
sur l'écran physique**. Les tests dans WSL2 sur un PC Windows ne peuvent
pas, à eux seuls, prouver une isolation de clé et une approbation indépendante
par un appareil hardware.

## Arrêt de sécurité

- Aucun appel réseau DOGE mainnet, aucun vrai DOGE, aucune phrase Trust Wallet
- Aucun test réel avec ton solde (même si tu acceptes de le perdre)
- Aucun contournement H8.1–H8.5 et aucune déclaration D8 PASS
- Aucune fusion vers la production ou mise en ligne de swaps
