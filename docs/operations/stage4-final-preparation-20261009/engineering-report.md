# GPUbnb Stage 4 — préparation finale, 9 octobre 2026

Aucune signature, intervention PC1, modification Render, fusion ou session physique exécutée. Les deux essais physiques restent en échec. Ce rapport complète le dossier `../stage4-readiness-20261009/`, dont les sept empreintes ont été contrôlées.

## GitHub et contrôles

| Source | Preuve | Résultat |
|---|---|---|
| PR #285, fe0b1cde | CI 37978709771; helper 37978709636 et cinq autres workflows PR | Réussite; PR brouillon, non fusionnée |
| Vérificateur, f797af63 | CI 37989110185; Authenticode 37989110108 | Réussite; 34 vérifications sur chacun des deux moteurs PowerShell |
| Gateway, 0c901bbf | CI 37991671609; préqualification 37991671696 | Réussite; API 795/797, 2 ignorés; Agent 617 tests, 3 ignorés; compilation et TypeScript strict |
| Dossier, 41c4e019 | CI 37992051852 | Échec: quota de téléchargement Docker Hub avant les tests; faux positif Gitleaks sur un commit public en ligne 7 du rapport |
| Correction de préparation, fd936033 | CI 37993779783; préqualification 37993779398 | Réussite |

Les lancements f797af63 37992039659 et 37992039633 sont annulés, distincts des validations réussies. Le push fe0b1cde 37988563153 est également annulé; cela ne remplace pas les workflows PR réussis.

Correction supplémentaire limitée à `.github/workflows/ci.yml`, au libellé du commit public dans l'ancien rapport et à ses sommes de contrôle. Les images officielles PostgreSQL/Redis utilisent le miroir public ECR déjà validé pour le candidat. Aucune exception Gitleaks, règle ignorée, réduction d'audit ou modification des permissions. Diff exact: https://github.com/khemisset18/gpubnb/compare/41c4e019f1a35786d7ccdede58ccb68e5de26323...fd936033f1f65ab8f585ca059120541b0457afc8 . Le patch brut reproduisait le libellé ancien et déclenchait le même faux positif Gitleaks: il est remis séparément, sans aucune exception de sécurité dans le dépôt.

## Compatibilité et provenance

Le candidat est composite: gateway 0c901bbf, helper fe0b1cde, vérificateur f797af63. La branche gateway conserve un ancien helper: NE PAS y construire le binaire Windows. Les sources Rust du helper sont identiques entre fe0b1cde et f797af63. L'artefact qualifié provient exclusivement du workflow helper fe0b1cde.

La chaîne gateway est 6b655614 → f792af7f → c03d0118 → 985d616a → 0c901bbf. Quinze fichiers diffèrent du baseline; aucune migration n'est modifiée. Les modules WebCodecs sont inchangés; les paramètres de configuration ont leurs tests de compatibilité. Le contrat binaire gateway ws@7 et la lecture TCP partielle Rust ont leurs tests reproductibles. Les tests du navigateur sur le checkout gateway réel ont de nouveau réussi: 25 tests. Les contrôles CI Agent et contrat intercomposants réussissent. Cela démontre la compatibilité du code testé, pas celle des binaires actuellement installés sur PC1, dont les versions embarquées manquent.

Le helper AMD64 est NON SIGNÉ. Empreintes, origine CI, taille, expiration et pin worker compilé figurent dans le manifeste. Le compilateur de qualification vérifie aussi la politique média du worker et le commit source: tout désaccord impose un arrêt. Ne pas désactiver ces exigences pour conserver un ancien worker.

## Chaîne de signature

| Élément | Statut |
|---|---|
| Sujet et empreinte SHA-1 observés sur les quatre fichiers PC1 | Vérifiés historiquement; certificat local de qualification seulement |
| Empreinte SHA-256 feuille, validité courante, EKU Code Signing | Non résolus; prochaine collecte publique en lecture seule, avec accord |
| Pin worker compilé et politique média effective installée | Non résolus; comparaison obligatoire avant toute signature/installation |
| Poste dédié et protection de la clé existante | Non résolus; aucun matériel de clé demandé |
| Service HTTPS RFC 3161 | Proposition SwissSign; non approuvée; admissibilité contractuelle et chaîne Windows à confirmer |
| Hash final signé et horodatage | Absents; aucun fichier signé |

Le helper utilise WinVerifyTrust et une identité de certificat feuille épinglée pour le worker; la DLL média possède également une identité épinglée. Les contrôles du jeton locataire, du PID et des communications locales restent obligatoires. Le constructeur production rejette explicitement le certificat LOCAL PHYSICAL TEST ONLY: ne pas utiliser ce constructeur, ni affaiblir ce refus. `verify-windows-release.ps1` installe et redémarre: ce n'est pas un outil de collecte PC1.

## Render et risques

Lecture Render: service srv-dau86i2d0e5s73elmk10, workspace tea-d9e21gbrjlhs73bivqo0, déploiement LIVE dep-db4j8gom7kps73c1u4p0 au commit 6b655614. Branche configurée qualification/stage3-windows-native-private-3c3e21e6, déploiement automatique désactivé. 0c901bbf n'est pas déployé. C'est un service Web HTTPS de qualification; le nom privé ne signifie pas réseau inaccessible publiquement. Aucun changement d'exposition autorisé.

Le retour arrière cible un baseline API opérationnel, pas un baseline physiquement stable. Les retards Agent et ouvertures déjà annulées restent un risque: deux dispatchs tardifs observés à 18:42:53 après les délais gateway. WinError 10058 signifie qu'une opération rencontre une socket arrêtée; ne prouve pas qui a initié la fermeture. Les 409 observés après fermeture ne démontrent pas une cause initiale. Aucun diagnostic actuel n'écarte un blocage capture/NVENC, une saturation ou un retard de traitement sous charge physique.

Le Dockerfile exécute prisma migrate deploy au démarrage. Toute migration en attente, dérive de configuration, artefact expiré, pin différent, signature non valide, horodatage absent, session/lease active ou retour arrière indisponible bloque l'exécution. Aucun changement de leases, authentification, isolation, suspension/reprise, facturation, politiques worker ou confiance n'a été apporté.

## Décision

GO préparation documentaire et CI. NO-GO signature, déploiement privé, installation PC1 et qualification physique tant que les préconditions et autorisations distinctes ne sont pas réunies. GPUbnb n'est pas déclaré réparé. La preuve finale exige 300 secondes continues de vidéo réelle, clavier et souris fonctionnels, sans coupure ni reconnexion répétée.

Prochaine action unique: demander l'accord pour une seule commande PowerShell PC1 lisant les certificats publics et empreintes des quatre binaires déjà identifiés; aucun lancement de binaire, magasin modifié, clé exportée ou service touché.
