# Passage Mainnet — procédure obligatoire

## 1. Déployer le contrat

Installer les versions compatibles de Solana CLI, Rust et Anchor. Générer une nouvelle paire de clés de programme, remplacer `declare_id!` et les identifiants d'Anchor.toml, puis exécuter les tests locaux et Devnet.

Ne réutilisez pas le Program ID d'exemple inclus dans le dépôt.

## 2. Initialiser la configuration

Initialiser le PDA `config` avec :

- portefeuille plateforme : `B5WQmXWHL8R86wf3LHLRE4aQAuRdRSz1EXKcwNQDqj2e` ;
- oracle : portefeuille de règlement protégé ;
- admin : portefeuille multisignature recommandé.

## 3. Audit

Faire auditer le commit exact, le binaire `.so` exact et le Program ID exact. Tester notamment : droits admin/oracle, double règlement, comptes substitués, dépassements arithmétiques, fermeture des comptes, litiges, remboursements expirés et comportement du programme mis en pause.

## 4. Variables serveur Mainnet

```env
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_URL=https://VOTRE_RPC_PRIVE
ESCROW_PROGRAM_ID=PROGRAM_ID_DEPLOYE_ET_AUDITE
ALLOW_MAINNET=true
PLATFORM_WALLET=B5WQmXWHL8R86wf3LHLRE4aQAuRdRSz1EXKcwNQDqj2e
COMMISSION_BPS=500
```

`ALLOW_MAINNET=true` ne rend pas le contrat sûr : ce verrou empêche seulement une activation accidentelle.

## 5. Exploitation

Un hébergement gratuit peut s'endormir ou manquer de garanties. Pour de vrais fonds, prévoir au minimum : base sauvegardée, Redis durable, alertes, RPC payant avec limites connues, journaux, rotation des secrets, portefeuille admin multisignature et procédure d'arrêt d'urgence.
