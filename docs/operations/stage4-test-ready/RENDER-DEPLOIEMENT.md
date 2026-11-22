# Render — qualification privée, état et plan soumis à validation

**Aucun réglage Render ni déploiement n'a été modifié.** L'accès utilisé pour
ce constat était strictement en lecture seule.

## État relu le 21 novembre 2026

Service [`gpubnb-stage3-private`](https://dashboard.render.com/web/srv-dau86i2d0e5s73elmk10),
ID `srv-dau86i2d0e5s73elmk10`, dépôt `khemisset18/gpubnb`.

- Branche du service : `stage4-private-pc1-23a7-qualification-20261115`.
- Auto-déploiement : `no` / déclencheur `off`.
- Déploiement actif : `dep-dbsut9tg1s2s7389m1q0`, SHA
  `23a7a2950ecf365866f3531ddbf76920d9fcb295`, statut `live`.
- Type Docker, Dockerfile `./apps/api/Dockerfile`, santé `/health`, une instance,
  région Frankfurt; aucun port de contrôle supplémentaire déclaré ouvert.
- L'allow-list HTTP comprend `0.0.0.0/0`, donc le service web est accessible
  depuis Internet. La page n'est pas privée au sens d'un filtrage réseau.
- La page active sert une ancienne qualification Stage 3 à un seul bouton,
  pas les quatre sélections de la PR #380. Elle affiche « Prêt. » avant toute
  preuve hôte; ne pas prendre ce texte comme un statut de sécurité ou de média.
- Aucune valeur d'environnement n'a été lue ou changée. `BETA_TEST_DEV_BYPASS`
  et `ESCROW_PROGRAM_ID` ne sont donc pas attestés sur le service live.

Référence de blocage complète :
[`WINDOWS_NATIVE_PRIVATE_QUALIFICATION_BLOCKERS.md`](../WINDOWS_NATIVE_PRIVATE_QUALIFICATION_BLOCKERS.md).

## Plan de déploiement privé à valider par l'opérateur

Le service reste en l'état et auto-déploiement OFF jusqu'à une approbation
explicite. La PR #380 ne doit pas être déployée tant que l'audio Cloud Desktop,
le package signé, la qualification des sessions de travail, les licences et
la revue indépendante HEAD-exacte sont incomplets.

Quand ces portes seront fermées :

1. Relire le SHA exact de la PR #380 et les résultats CI associés. Obtenir une
   revue GitHub formelle `APPROVED` sur ce SHA exact; aucun commit postérieur
   ne peut hériter de cette approbation.
2. Vérifier l'artefact CI issu de ce SHA : provenance, manifeste, SHA-256,
   signature du Host/Agent/tunnel/helper/worker/DLL et signature du pilote
   IddCx si requis. Un candidat unsigned reste non-installable.
3. Avant d'exposer la page, faire approuver l'accès du Stage et réduire
   l'ingress public ou mettre en place une allow-list vérifiée. La configuration
   Render actuelle autorise `0.0.0.0/0`; ne pas appeler cela « accès privé ».
4. Dans le service exact ci-dessus, conserver auto-déploiement OFF. Un opérateur
   autorisé sélectionne le SHA précis avec Manual Deploy; aucune mise à jour du
   site public, du Blueprint public ou des variables Render ne doit être faite
   dans le cadre de cette PR sans accord séparé.
5. Vérifier `/health`, `/ready`, `/release`, le `releaseCommit` navigateur,
   l'authentification et le refus du préflight anonyme. Vérifier le mode privé
   sans paiement sans exposer de valeurs de secrets. Ne pas créer de réservation
   comme test de santé.
6. Sur PC1 dédié et non sensible, vérifier le SHA du package, les signatures
   Windows, le compte locataire standard, la session WTS exclusive, la source
   d'écran locataire, le GPU NVIDIA exact, l'isolation réseau et le nettoyage
   STOP. PC2 ne reçoit qu'une session navigateur authentifiée.
7. N'ouvrir la qualification que pour les Workspaces effectivement activés,
   avec un plan de stop et d'escalade. Aucun paiement réel, publication
   marketplace, changement de quarantaine ou site public.

Ce plan ne constitue pas une autorisation de déployer. À l'état présent, le
résultat approprié demeure **NO-GO**.
