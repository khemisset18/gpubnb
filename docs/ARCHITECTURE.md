# Architecture de production GPUbnb

## Frontières de confiance

1. `apps/web` est un client statique non fiable. Il ne contient que les clés
   publiques Supabase et ne décide jamais d'un prix, d'une autorisation ou de la
   finalité d'un paiement.
2. `apps/api` valide les sessions, le CSRF, les autorisations, les disponibilités
   et les preuves Solana. PostgreSQL est la source de vérité métier et Redis ne
   contient que des données éphémères (sessions, nonces et anti-rejeu).
3. Le programme Anchor détient les fonds. La commission est fixée à 500 points
   de base et l'échéance de remboursement est calculée on-chain à partir de la
   fin de réservation plus 3 600 secondes.
4. L'agent fournisseur signe la télémétrie avec une clé dédiée. Il ne reçoit ni
   clé de session utilisateur ni clé de déploiement Solana.
5. Le lanceur sandbox doit fonctionner sous un compte système non privilégié.
   Il accepte uniquement une image immuable par digest et monte seulement les
   dossiers `input` et `output` d'une réservation.

## Identités et sessions

`User` est le compte métier. `AuthIdentity` contient les sujets Supabase ou
Phantom et `UserWallet` contient les adresses de paiement/versement. Les
contraintes uniques empêchent le rattachement d'une identité ou d'un wallet à
deux comptes. `User.wallet` est un champ de compatibilité temporaire et ne doit
plus être utilisé pour les paiements.

La session API est un identifiant aléatoire stocké dans un cookie `HttpOnly`,
`Secure` en production et `SameSite=Strict`. Redis ne stocke que son HMAC. Une
expiration absolue et une expiration d'inactivité sont appliquées. Chaque
opération mutante authentifiée exige en plus le jeton CSRF lié à la session.
L'incrément de `User.sessionVersion` révoque immédiatement toutes les sessions,
même si une entrée Redis subsiste jusqu'à son TTL.

## Exécution GPU réellement couverte

Le dépôt implémente : digest d'image obligatoire, réseau désactivé, filesystem
racine en lecture seule, suppression des capabilities, `no-new-privileges`,
limites CPU/RAM/PID, utilisateur non-root, refus de symlinks, confinement des
chemins, timeout, heartbeat signé, anti-rejeu et nettoyage contrôlé.

Il ne fournit pas à lui seul une frontière équivalente à une VM. gVisor, Kata,
Firecracker, IOMMU/MIG, Falco/eBPF, registre signé Cosign, stockage chiffré et
journaux externes append-only exigent l'infrastructure de l'opérateur. Ces
contrôles doivent être validés par un audit hôte/GPU avant toute charge hostile.

## Déploiement et reprise

L'API est construite en image multi-stage, exécute les migrations avant le
serveur et expose `/health` et `/ready`. PostgreSQL doit disposer de sauvegardes
PITR testées. Redis peut être reconstruit au prix de la déconnexion de toutes les
sessions. Le programme mainnet reste interdit tant que `mainnet-gate.sh` ne
dispose pas des preuves d'audit, pentest, multisig et déploiement.
