# Blocages et autorisations restantes

## À ne pas confondre avec un défaut du build

- **Signature privée non effectuée.** Le certificat et la confiance Windows actuels ne sont pas accessibles depuis cet environnement. Le pin réel historique est connu ; son expiration observée est le 20/10/2026 à 22:23:47 UTC. Les contrôles locaux imposent clé, EKU, chaîne, dates et pins. Un certificat nouveau exige un nouveau pin réel et une reconstruction cohérente avant signature.
- **Matériel PC1 non qualifié.** Aucune preuve nouvelle de session console locataire exclusive, isolation du bureau, compatibilité ABI IddCx, capture ou encodage NVENC GTX1650 n'a été produite. Les observations utilisateur précédentes restent des observations historiques.
- **Installation et sauvegarde PC1 non exécutées.** Les quatre fichiers installés appartiennent aux anciens commits mentionnés dans PC1-PREPARATION.md. La procédure de sauvegarde/retour est fournie ; vérifier aussi la validité temporelle du certificat des anciens binaires avant de compter sur leur restauration.
- **Render Stage 4 non déployé.** L'auto-deploy OFF et le Stage 3 live ont été relus. La valeur actuelle de BETA_TEST_DEV_BYPASS n'est pas exposée par la lecture disponible ; l'opérateur doit vérifier la paire de paramètres privés avant l'autorisation de déploiement. Aucun secret ne doit être partagé. Le statut de la migration RLS supplémentaire et les permissions du rôle Prisma doivent également être contrôlés avant une migration expressément autorisée ; le Dockerfile configuré ne l'applique pas au démarrage.
- **Test physique réservé à l'utilisateur.** Aucun POST de réservation réel, paiement, lancement de session native ou test de cinq minutes n'a été exécuté. Le parcours navigateur privé et sa gateway santé sont identifiés ; le site public Netlify est un autre déploiement.

## Preuve logicielle à retenir

L'archive acceptée est exclusivement l'artefact `stage4-unsigned-four-components-<SHA>` du workflow complet au HEAD final, avec quatre PE AMD64 et le manifeste externe vérifié. Un artefact `stage4-rejected-package-diagnostics-*` est une preuve d'échec, jamais un paquet installable. Les artefacts Host/helper isolés ou leurs hashes historiques ne satisfont pas ce contrat.

Le premier build complet a bloqué sur la dépendance pefile exclue par PyInstaller ; le verrou a été corrigé. Le suivant a produit les quatre PE mais les deux lecteurs d'imports comparaient un tri régional à un tri ordinal ; la comparaison a été rendue déterministe et testée. Ne retenir que les résultats de la reconstruction finale, pas ces tentatives échouées.

## Limites de vérification locale

Les tests Python Agent, navigateur, lecteurs PE, Rust portables et tests API ciblés peuvent être exécutés ici. PowerShell local ne peut pas initialiser CoreCLR dans ce sandbox ; les vérifications 5.1/7 et le build PE sont exécutés sur les runners Windows GitHub. La suite API complète requiert PostgreSQL/Redis ; ses erreurs locales de connexion ne sont pas des PASS. La CI doit fournir les résultats de cette suite avec ses services réels. Aucun contrôle n'est désactivé pour transformer ces limites en succès.
