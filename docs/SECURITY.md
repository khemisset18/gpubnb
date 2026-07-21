# Modèle de sécurité

## Garanties implémentées
- Nonces d'authentification consommés une seule fois dans Redis.
- Cookies de session opaques HttpOnly/SameSite.
- CORS limité à l'origine publique.
- Heartbeats avec challenge à usage unique, compteur monotone et fenêtre temporelle.
- États de connectivité, exploitation et modération séparés.
- DTO public sans clé d'agent ni portefeuille complet.
- Tous les montants restent en `bigint` et sont sérialisés en chaînes.
- Endpoint de maintenance protégé par secret de service.
- Règlement testé avec invariant de conservation des lamports.

## Limites obligatoires avant Mainnet
- Audit indépendant du programme Anchor compilé et de son ID réel.
- Multisig pour admin, oracle et upgrade authority.
- Oracle redondant : l'agent fournisseur seul n'est jamais une preuve suffisante.
- Sandbox GPU testée contre l'évasion, idéalement microVM/Kata selon le matériel.
- Tests dynamiques avec validateur Solana local, chaos réseau et pannes électriques.
- Pentest de l'infrastructure réellement déployée.
