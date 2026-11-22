# PC2 — statut du test navigateur Windows natif

**NO-GO au 21 novembre 2026. Aucun essai PC1 → PC2 ne doit être lancé depuis
la version actuellement servie.** Cette note remplace le déroulé positif daté
du 18 octobre ci-dessous : son ancienne attente `allowed=true` et son bouton de
démarrage ne s'appliquent plus à l'état courant.

## État live vérifié en lecture seule

- Service : [`gpubnb-stage3-private`](https://dashboard.render.com/web/srv-dau86i2d0e5s73elmk10)
- URL de la page actuellement servie : <https://gpubnb-stage3-private.onrender.com/stage3-windows-native.html>
- Déploiement actif : `dep-dbsut9tg1s2s7389m1q0`, SHA
  `23a7a2950ecf365866f3531ddbf76920d9fcb295`, branche
  `stage4-private-pc1-23a7-qualification-20261115`
- Auto-déploiement : désactivé.
- La page live ne présente pas les quatre choix de la PR #380. Elle affiche
  encore un seul bouton « Démarrer le test Windows » et le statut « Prêt. »
  avant toute preuve de PC1. Ce libellé ne prouve ni le Host ni le streaming.
- La liste d'adresses autorisées Render inclut `0.0.0.0/0`; ne pas confondre
  l'absence de publication marketplace avec une restriction réseau du site.
- Les valeurs des variables Render ne sont pas vérifiées ici; l'état live du
  mode privé sans paiement reste inconnu.

## État du code PR #380

La branche de la PR contient les boutons Cloud Desktop, Creator / Blender,
CAD / FreeCAD et Gaming / Steam, mais **aucun bouton de lancement n'est actif**.
Le préflight API est en lecture seule. Le serveur refuse les réservations et
sessions privées tant que le streaming audio Windows → navigateur n'est pas
implémenté et qualifié; les chemins Cloud Desktop, Creator, CAD et Gaming
restent donc indisponibles. Les choix ne doivent jamais rediriger vers un autre
Workspace.

Référence actuelle des blocages, du package et du plan de déploiement :
[`WINDOWS_NATIVE_PRIVATE_QUALIFICATION_BLOCKERS.md`](../WINDOWS_NATIVE_PRIVATE_QUALIFICATION_BLOCKERS.md).

## Quand un test pourra être autorisé

Reprendre le test uniquement après revue formelle `APPROVED` sur le HEAD exact,
CI réussie sur ce même SHA, package Windows signé et vérifié, média complet
pour le profil visé, confirmation des licences commerciales, et preuve
d'isolation/STOP sur un Host Windows dédié sans données personnelles. Déployer
manuellement uniquement vers le service privé après approbation de l'opérateur;
ne pas utiliser le service public.

Après ces autorisations, PC2 pourra se connecter au site privé, sélectionner
le Workspace effectivement autorisé par le serveur, exécuter le préflight et
ouvrir uniquement l'accès lié à la réservation et au GPU exact. Ne pas créer
de réservation si l'API ne renvoie pas une autorisation cohérente pour le même
SHA, le même Workspace et le même Host. Aucun test de streaming physique n'a
été effectué par Codex.
