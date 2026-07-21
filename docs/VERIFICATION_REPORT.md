# Rapport de vérification — 18 juillet 2026

## Réussites

- Syntaxe Python de l'agent : OK.
- Syntaxe JavaScript du frontend : OK.
- Tests du règlement : 3/3 réussis.
- Invariant testé pour chaque durée de 0 à 3 600 secondes : fournisseur + plateforme + remboursement = dépôt.
- Commission : 500 points de base sur la partie payable.
- Seuil : paiement intégral à partir de 90 % de disponibilité ; proportionnel en dessous.
- Mainnet désactivé dans la configuration fournie.
- Aucune annonce fictive intégrée.
- Aucun secret privé fourni dans l'archive.

## Vérification empêchée par l'environnement

`prisma generate` a tenté de télécharger le moteur Prisma depuis `binaries.prisma.sh`, mais la résolution réseau a échoué (`EAI_AGAIN`). La compilation TypeScript complète doit être relancée dans la CI avec accès réseau :

```bash
npm ci
npm run build
npm test
```

## Dépendances

`npm audit` signale trois vulnérabilités modérées transitives dans la chaîne Solana. Elles sont conservées dans `npm-audit.json`. Elles doivent être réévaluées à chaque mise à jour ; ne pas appliquer `--force` sans tests de régression.

## Verdict

- Frontend Netlify : déployable comme interface connectée à une API.
- API : release candidate Devnet, à compiler dans la CI.
- Escrow : code renforcé mais non certifié et non déployé.
- Mainnet : NO-GO avant audit indépendant, multisig, oracle redondant et pentest de la sandbox.
