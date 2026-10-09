# Phase A — signature, INTERDITE sans accord distinct

1. Confirmer le poste Windows dédié autorisé et la protection de la clé existante, inaccessible à PC1. Aucun PFX, mot de passe ou clé ne doit être collecté. Le service managé n'est utilisable que si les scripts existants peuvent utiliser cette même identité sans modifier la politique de confiance.
2. Comparer le certificat public à celui du worker PC1: sujet, empreinte SHA-1 connue, empreinte SHA-256 feuille, EKU 1.3.6.1.5.5.7.3.3, dates actuelles, chaîne et révocation. Comparer le pin worker de l'artefact et la politique média effective. Un désaccord arrête la phase; aucun nouveau certificat ni changement de magasin.
3. Faire approuver explicitement une URL HTTPS RFC 3161. Proposition technique: https://tsa.swisssign.net. Les documents officiels publient HTTPS, RFC3161 et SHA-256; conditions commerciales, disponibilité actuelle et chaîne de confiance Windows restent à établir. Aucune approbation ni requête effectuée. Documents: https://repository.swisssign.com/SwissSign_PDS_TSA_EN_R1.pdf et https://repository.swisssign.com/SubscriberAgreement_SigServ_TSA_R01.pdf. Les endpoints HTTP documentés par d'autres fournisseurs ne satisfont pas la politique HTTPS; ne pas inventer une variante HTTPS.
4. Extraire sur le poste dédié uniquement l'artefact 11639950809 du workflow 37978709636. Vérifier l'archive et le helper contre le manifeste. Ne jamais compiler depuis 0c901bbf. Charger les scripts révisés issus de f797af63. L'absence d'une information préalable interdit de passer au point 5.
5. Après accord de signature, avec les valeurs publiques approuvées et le chemin fixé sur le poste de signature:

```powershell
$env:GPUBNB_CODESIGN_THUMBPRINT = '6B8A9EA7C26791668CA31863DC68A7B5F88FC6EC'
$env:GPUBNB_CODESIGN_TIMESTAMP_URL = $ApprovedTimestampHttpsUrl
& .\scripts\sign-windows-authenticode.ps1 -Path $ApprovedHelperPath
& .\scripts\verify-windows-authenticode.ps1 -Path $ApprovedHelperPath -Required -RequireTimestamp -ExpectedSignerSha256 $ApprovedLeafSha256
Get-FileHash -LiteralPath $ApprovedHelperPath -Algorithm SHA256
```

Les variables Approved doivent être remplies dans le dossier d'autorisation; aucune valeur inconnue n'est une valeur par défaut. Le script utilise SignTool avec /fd SHA256 /tr et /td SHA256 puis exige la vérification Authenticode. Toute exception ou code non nul arrête la procédure. Ne pas lancer le constructeur production qui signe plusieurs composants et rejette ce certificat local.
6. Produire un nouveau manifeste: origine et version CI, empreinte avant signature, empreinte finale réellement mesurée, identités des certificats, horodatage réellement obtenu, URL approuvée, résultats du vérificateur et de SignTool verify /pa /all /v /tw. Exiger absence d'avertissement et code 0. Conserver les fichiers source et signé séparément, vérifier indépendamment sur Windows. Aucun fichier signé n'existe actuellement et les champs correspondants restent vides.
7. Autorisation A ne vaut ni transfert PC1 ni installation ni déploiement. En cas d'échec, mettre le candidat en quarantaine et repartir de l'archive CI vérifiée; ne pas modifier la confiance.
