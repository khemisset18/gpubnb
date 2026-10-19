# Blocages et autorisations restantes

## À ne pas confondre avec un défaut du build

- **Signature privée Stage 4 effectuée sur PC1 et vérifiée.** Le paquet signé 4/4 source `447b8f3f931bd61d3131cff6f7204d7625b108b2` a passé `verify-stage4-package.ps1` (`ok=true`, `authenticodeVerified=true`) ; manifeste signé SHA256 `b7427f698c3a9dc8bc86eb4443f7531b03d10031ab20fc01f57a15cb4880b5b5`. Nouveau signer SHA256 `88662fb76d4237aa3842ad1ad8d0378a17ffb82d022f860b297ed85e2c08c99a`, valide jusque `2026-11-01T21:30:09Z`. **Non installé.** Les signatures restent réservées au test privé, sans timestamp.
- **Sauvegarde existante réussie, restauration durable non attestée.** Quatre fichiers sauvés et indépendamment re-hashés, backup manifeste SHA256 `578d687907c398d7dd8d24af5717ead158c78a2210fd6796b7c961435ac17f86`, `restorableWithoutFurtherChecks=false`. Ancien signataire expire `2026-10-20T22:23:47Z` et les signatures historiques n'ont **aucun** horodatage. Voir [RETOUR-ARRIERE-HORODATAGE.md](RETOUR-ARRIERE-HORODATAGE.md). Préflight offline et création opt-in de copies horodatées préparés ; **aucune TSA contactée, aucun horodatage ni restauration réellement effectué**. Restitution après expiration non garantie et NO-GO avant preuve.
- **Trust / processus PC1 non qualifiés.** Nouveau certificat approuvé dans le CurrentUser de l'opérateur pour la signature; confiance SYSTEM et locataire non démontrée. Service GPUbnbAgent Stopped/PID 0, mais deux processus exécutables observés séparément en sessions 0 et 1, second depuis GPUbnb Host. Corréler les processus avant tout arrêt.
- **Matériel PC1 non qualifié.** Aucun bail Windows validé en session locataire console exclusive, aucune preuve de capture/encodage NVENC réel ou d'ABI IddCx validée. L'inventaire GPU seul ne vaut pas test physique.
- **Render Stage 4 non déployé.** L'auto-deploy OFF et le Stage 3 live ont été relus. La valeur actuelle de BETA_TEST_DEV_BYPASS n'est pas exposée par la lecture disponible ; l'opérateur doit vérifier la paire de paramètres privés avant l'autorisation de déploiement. Aucun secret ne doit être partagé. Le statut de la migration RLS supplémentaire et les permissions du rôle Prisma doivent également être contrôlés avant une migration expressément autorisée ; le Dockerfile configuré ne l'applique pas au démarrage.
- **Test physique réservé à l'utilisateur.** Aucun POST de réservation réel, paiement, lancement de session native ou test de cinq minutes n'a été exécuté. Le parcours navigateur privé et sa gateway santé sont identifiés ; le site public Netlify est un autre déploiement.

## Preuve logicielle à retenir

L'archive acceptée est exclusivement l'artefact `stage4-unsigned-four-components-<SHA>` du workflow complet au HEAD final, avec quatre PE AMD64 et le manifeste externe vérifié. Un artefact `stage4-rejected-package-diagnostics-*` est une preuve d'échec, jamais un paquet installable. Les artefacts Host/helper isolés ou leurs hashes historiques ne satisfont pas ce contrat.

Le premier build complet a bloqué sur la dépendance pefile exclue par PyInstaller ; le verrou a été corrigé. Le suivant a produit les quatre PE mais les deux lecteurs d'imports comparaient un tri régional à un tri ordinal ; la comparaison a été rendue déterministe et testée. Ne retenir que les résultats de la reconstruction finale, pas ces tentatives échouées.

## Limites de vérification locale

Les tests Python Agent, navigateur, lecteurs PE, Rust portables et tests API ciblés peuvent être exécutés ici. PowerShell local ne peut pas initialiser CoreCLR dans ce sandbox ; les vérifications 5.1/7 et le build PE sont exécutés sur les runners Windows GitHub. La suite API complète requiert PostgreSQL/Redis ; ses erreurs locales de connexion ne sont pas des PASS. La CI doit fournir les résultats de cette suite avec ses services réels. Aucun contrôle n'est désactivé pour transformer ces limites en succès.
