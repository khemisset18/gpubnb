# Migration du modèle d'authentification

La migration `0003_multi_identity_auth` sépare le compte métier (`User`), les
identités de connexion (`AuthIdentity`) et les wallets Solana (`UserWallet`). Un
wallet n'est donc plus implicitement l'identité, le moyen de paiement et
l'adresse de versement à la fois.

## Pré-vérification obligatoire

Sauvegarder PostgreSQL puis exécuter, sur une copie restaurée de production :

```sql
SELECT lower("pseudonym"), count(*) FROM "User"
GROUP BY lower("pseudonym") HAVING count(*) > 1;

SELECT "id", "pseudonym" FROM "User"
WHERE "pseudonym" !~ '^[A-Za-z][A-Za-z0-9_-]{2,31}$';

SELECT "id" FROM "User" WHERE "wallet" = 'supabase:';

SELECT "userId" FROM "Profile"
WHERE length("bio") > 1000 OR length("avatarUrl") > 2048;
```

La migration s'arrête explicitement si ces requêtes trouvent une collision ou
un ancien pseudonyme incompatible. Aucun pseudonyme existant n'est réécrit
silencieusement.

## Backfill et compatibilité

- `supabase:<subject>` devient une identité `supabase`.
- Toute autre valeur historique devient une identité `phantom` et un
  `UserWallet` vérifié, utilisable pour authentification, paiement et versement.
- Les préférences de notification sont créées avec des valeurs prudentes.
- `User.wallet` reste présent et devient nullable pendant une version de
  transition. Aucun nouveau compte ne doit l'utiliser. Il pourra être supprimé dans une migration
  ultérieure, après déploiement de tous les consommateurs du nouveau modèle.
- Les réservations, paiements, machines, annonces et relations utilisateurs ne
  changent pas de clé et ne sont pas réécrits.

Les identifiants du backfill sont déterministes et les insertions sont
idempotentes. Le fichier SQL ouvre explicitement une transaction PostgreSQL : une
erreur ne laisse donc pas un modèle partiellement migré.

## Déploiement et récupération

1. Faire une sauvegarde et tester sa restauration.
2. Exécuter les requêtes de pré-vérification sur la restauration.
3. Déployer d'abord un binaire compatible avec l'ancien et le nouveau modèle.
4. Exécuter `npx prisma migrate deploy` une seule fois.
5. Vérifier les nombres d'utilisateurs, identités et wallets puis effectuer les
   parcours Supabase et Phantom.

Un rollback de schéma destructif n'est pas fourni : il supprimerait l'historique
de sessions et de sécurité créé après migration. En cas d'incident, revenir au
binaire précédent (le champ `User.wallet` est conservé). Si la migration elle-même
échoue, restaurer la sauvegarde vérifiée plutôt que lancer `migrate reset`.
