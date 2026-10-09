# Certificat Stage 4 — procédure préparée, non exécutée

Aucune collecte nouvelle sur PC1 n'est autorisée dans la mission actuelle. Les commandes ci-dessous sont un plan de revue ; une autorisation distincte de lecture seule est nécessaire avant de les lancer sur PC1. Une seule commande PowerShell à la fois. Ne jamais exporter de certificat avec clé, demander PFX/mot de passe, lire token/configuration Agent, importer une racine ou signer un fichier.

## A. Certificats publics des quatre fichiers installés

L'expression suivante ne lit que fichiers connus, signatures et certificats publics. Elle ne lance aucun binaire GPUbnb et ne lit aucune clé privée. Elle utilise LiteralPath. Elle produit l'empreinte SHA-256 du certificat feuille, distincte du SHA-256 du fichier et du thumbprint SHA-1. Un résultat Valid historique ne dispense pas de vérifier la validité courante et l'EKU.

```powershell
& {
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    $now = [DateTime]::UtcNow
    $root = 'C:\Program Files\GPUbnb'
    $rows = foreach ($name in @(
        'gpubnb-agent.exe', 'gpubnb-windows-stream.exe',
        'gpubnb-windows-worker.exe', 'GPUbnbWindowsMedia.dll'
    )) {
        $path = Join-Path $root $name
        $signature = Get-AuthenticodeSignature -LiteralPath $path
        $certificate = $signature.SignerCertificate
        $ekuOids = @()
        if ($null -ne $certificate) {
            foreach ($extension in $certificate.Extensions) {
                if ($extension.Oid.Value -eq '2.5.29.37') {
                    $eku = [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new(
                        $extension, $extension.Critical
                    )
                    $ekuOids += @($eku.EnhancedKeyUsages | ForEach-Object { $_.Value })
                }
            }
        }
        [pscustomobject]@{
            File = $name
            FileSha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
            SignatureStatus = [string]$signature.Status
            SignerSubject = if ($certificate) { $certificate.Subject } else { $null }
            SignerSha1 = if ($certificate) { $certificate.Thumbprint } else { $null }
            SignerSha256 = if ($certificate) {
                $certificate.GetCertHashString(
                    [System.Security.Cryptography.HashAlgorithmName]::SHA256
                ).ToLowerInvariant()
            } else { $null }
            NotBeforeUtc = if ($certificate) { $certificate.NotBefore.ToUniversalTime().ToString('o') } else { $null }
            NotAfterUtc = if ($certificate) { $certificate.NotAfter.ToUniversalTime().ToString('o') } else { $null }
            CurrentlyValid = if ($certificate) {
                $now -ge $certificate.NotBefore.ToUniversalTime() -and
                $now -le $certificate.NotAfter.ToUniversalTime()
            } else { $false }
            EkuOids = $ekuOids
            ExplicitCodeSigningEku = ('1.3.6.1.5.5.7.3.3' -in $ekuOids)
            TimestampPresent = ($null -ne $signature.TimeStamperCertificate)
        }
    }
    [pscustomobject]@{
        CollectedAtUtc = $now.ToString('o')
        Files = @($rows)
    } | ConvertTo-Json -Depth 5
}
```

Conditions d'arrêt : pas de certificat, statut non Valid, thumbprint différent de l'identité autorisée, absence EKU Code Signing explicite, validité courante expirée/future, divergence de SHA-256 entre worker et pin helper. L'absence d'EKU explicite ne doit pas être remplacée par une permission « tous usages » par facilité. Aucun magasin de confiance n'est modifié.

## B. Poste de signature dédié ou service managé

Vérifier l'enregistrement exact `6B8A9EA7C26791668CA31863DC68A7B5F88FC6EC` dans le magasin prévu par le script existant (`Cert:\CurrentUser\My` sur un poste dédié), **sans recherche globale de secrets ni export**. Ne relever que certificat public, EKU, dates, SHA-256 et présence de clé sous forme booléenne. Pour un service managé, utiliser ses métadonnées publiques/policy en lecture seule et documenter l'intégration du script ; le certificat exact et sa protection doivent être identiques à l'identité déjà autorisée.

La présence d'une clé (`HasPrivateKey=True`) ne prouve pas non-exportabilité, accès restreint ou protection matérielle. Obtenir les attestations/policies du poste ou fournisseur, sans révéler le nom d'un conteneur privé ou une clé. PC1 ne doit posséder aucun accès à cette clé. Ne pas générer de certificat de remplacement ni importer un root.

## C. Policy worker et provenance

Chercher d'abord le manifeste de build déjà disponible et vérifier `sourceCommit`, `mediaSignerSha256`, `workerSignerSha256` contre les certificats publics. Si aucune preuve n'existe, proposer sous autorisation distincte la seule commande diagnostique documentée :

```powershell
& 'C:\Program Files\GPUbnb\gpubnb-windows-worker.exe' --build-policy --json
```

Cette commande exécute un binaire existant ; elle n'est pas incluse dans la simple lecture de certificats A et n'a pas été exécutée. Ne conserver que schemaVersion, sourceCommit et mediaSignerSha256. Arrêter si le worker ne sait pas fournir sa policy, si elle est vide, si le pin DLL ne correspond pas, ou si le script de qualification exige un même commit qui n'est pas satisfait. Ne pas modifier les checks pour accepter une provenance inconnue.

## D. Futur candidat signé

Après approbation du certificat, de la TSA HTTPS et de la signature, employer les scripts existants. La vérification de distribution obligatoire doit inclure :

```powershell
& .\scripts\verify-windows-authenticode.ps1 `
    -Path '<chemin candidat signé>' -Required -RequireTimestamp `
    -ExpectedSignerSha256 '<SHA-256 feuille confirmé>'
```

Les valeurs entre chevrons sont des prérequis manquants, pas des arguments exécutables. Contrôler aussi la date exacte et la chaîne du timestamp avec SignTool verify selon la policy Authenticode, puis enregistrer les sorties non secrètes et l'empreinte finale. Une erreur arrête la distribution ; aucune option facultative ne doit être utilisée pour installer.

Cette procédure ne donne aucune approbation TSA. L'URL HTTPS exacte, la chaîne de confiance et le fournisseur nécessitent la validation explicite de l'utilisateur. Aucune requête d'horodatage ni signature n'est faite pendant la préparation.
