# GPUbnb Stage 4 — maintenance privée, quatre fichiers et retour arrière

## Incident, remède et périmètre

Le PC1 connecté a un ancien `RentalClaimRecord` local lié exactement à la session native
`cmvvpd1s600aser1b06u33u86` et à la ressource
`e9ab8452-0349-4d3b-a209-868c633834a3`. Il est `RENTAL_ACTIVE`, tandis que le
`RuntimeRecord` correspondant est `STOPPED`, sans PID, identité de processus ni
commande. Le test de génération par l'opérateur a retourné `GenerationValide=True`.
Le serveur a refusé les diagnostics avec `native_cleanup_claim_authority_unverified`.

Le nouveau paquet signé épinglé (source `32ffdc72ec7041310c4b07e286ac4c4c2818906c`)
inclut le correctif précisément pour `RENTAL_ACTIVE` + runtime `STOPPED`, mais
n'autorise la libération du verrou qu'après autorisation signée du serveur, arrêt
Helper, quiescence NVIDIA et revalidation du fence.

## Maintenance physique proposée (non exécutée par CI)

La commande `scripts/stage4-private-four-file-maintenance.ps1` fonctionne par
défaut en **lecture seule**. Elle exige les mêmes deux manifestes épinglés,
les signatures de chaque binaire, les six contrôles de prévol, l'identité
LocalSystem et Session 0 du service, l'absence de processus Helper/Worker, une
seule autorité locale avec session/GPU/fence exacts et un runtime STOPPED sans
processus. La génération runtime doit être >= génération claim.

L'action volontaire exige les commutateurs simultanés `-Apply` et
`-OperatorPresentAndApproved`, sans lesquels aucune installation n'a lieu.

Le moteur partagé `stage4-private-four-file-transaction-core.ps1` :
1. Vérifie hashes et SDDL des quatre originaux live versus manifeste backup.
2. Prépare les quatre copies signées **dans le même dossier NTFS que les originaux** ;
   exige les quatre SHA du candidat et les mêmes SDDL que les quatre originaux.
   **Une différence ACL interrompt AVANT l'arrêt du service.**
3. Arrête uniquement `GPUbnbAgent` et confirme son arrêt.
4. Renomme chaque original en `.stage4-<GUID>.old.<nom>` sur le même volume,
   puis renomme la copie préparée en nom original. Aucune copie d'ACL :
   les renommages gardent leur provenance et leur propriétaire.
5. Vérifie les quatre hashes et SDDL post-commit, puis redémarre GPUbnbAgent.
   La sonde de santé attend un nouvel événement `heartbeat` émis après
   la reprise effective du service et la réussite de l'appel API signé.
6. En cas d'échec après arrêt, arrête au besoin le service, restaure les
   quatre fichiers old via renommage, vérifie 4/4 hashes et SDDL,
   redémarre le service. Toute défaillance de rollback est un
   **incident critique** ; ne pas tenter une nouvelle exécution.

Les originaux ne sont pas supprimés après succès. Les restes .stage4
doivent être conservés pour preuve et ne doivent jamais être utilisés
comme source d'installation. Les deux fichiers locaux de claims et runtime,
les clés, les ACL du dossier installé, le service public, la base Supabase,
la quarantaine et les réservations ne sont pas modifiés par ce script.

## Pourquoi pas File.Replace / Set-Acl ?

Les tests Windows ont montré que `Set-Acl` pouvait modifier le SDDL des copies.
Le test `File.Replace` a produit des ACE explicites en doublon des ACE héritées,
malgré la documentation Windows sur la fusion des métadonnées. Le moteur a
refusé l'ACL post-installation et restauré les originaux. Le protocole final
vérifie donc strictement les SDDL avant toute maintenance et ne fait que
des renommages dans un même parent.

Références Microsoft :
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilea
- https://learn.microsoft.com/en-us/dotnet/api/system.io.file.replace?view=netframework-4.8.1

## CI et limites

Le test `scripts/tests/stage4-private-four-file-transaction-core.tests.ps1`
exécute **le même moteur** sur quatre fichiers synthétiques sous TEMP :
succès nominal, interruptions injectées après chacun des 4 fichiers,
échec de démarrage une fois, échec de santé post-start, hash ancien erroné,
et tentative de chemin réel sans jeton. Il compare chaque hash et SDDL
et vérifie le retour du service **simulé**, jamais du service réel.

La réussite CI ne prouve pas les ACL de PC1 ni le rollback physique effectif.
La commande réelle s'arrêtera sans interrompre l'Agent si le staging ACL diffère.
Après succès, revérifier le heartbeat en base, et demander UN diagnostic OWNER
avec l'ancien claim persistant et le nouveau correctif. Toute levée de
quarantaine nécessite la preuve signée complète. Le vrai streaming PC1->PC2
avec locataire WTS exclusif et 300 secondes est **une autre validation**.
Ne jamais publier l'annonce ou capter le bureau admin sur la foi du
résultat de maintenance seul.

**Pas d'installation faite par GitHub, Render ou Supabase à la rédaction de ce document.**
