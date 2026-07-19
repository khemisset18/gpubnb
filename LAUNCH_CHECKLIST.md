# Checklist de lancement

## Obligatoire avant Devnet public
- [ ] Déployer PostgreSQL et Redis privés.
- [ ] Déployer l'API et appliquer les migrations.
- [ ] Configurer le domaine HTTPS et CORS.
- [ ] Générer des secrets aléatoires de 32 octets minimum.
- [ ] Déployer le programme Anchor avec un nouvel ID.
- [ ] Remplacer l'ID du programme dans le backend et le client.
- [ ] Configurer les autorités avec un multisig.
- [ ] Tester dépôt, règlement, remboursement, expiration et litige sur Devnet.
- [ ] Tester les coupures réseau et électrique de l'agent.
- [ ] Mettre en place alertes, sauvegardes et restauration.

## Obligatoire avant Mainnet
- [ ] Audit externe du programme compilé et de l'adresse réellement déployée.
- [ ] Test d'intrusion API et infrastructure.
- [ ] Test d'évasion de la sandbox GPU.
- [ ] Bug bounty limité puis public.
- [ ] Assurance et procédure d'incident.
- [ ] Conditions d'utilisation, confidentialité, remboursement et litiges.
- [ ] Validation juridique de l'exploitation sans KYC selon les juridictions ciblées.

Le Mainnet ne doit pas être activé tant que toutes les cases Mainnet ne sont pas validées par des tiers compétents.
