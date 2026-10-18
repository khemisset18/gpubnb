#Requires -Version 5.1
# Copies four existing components + ACL/service metadata to a NEW local directory.
# No configuration secret, certificate private key, service change or replacement.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputDirectory,[switch]$CreateBackup)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if(-not $CreateBackup){throw 'stage4_backup_explicit_create_switch_required'}
if($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess){throw 'stage4_windows_x64_required'}
. (Join-Path $PSScriptRoot 'stage4-package-common.ps1')
$installed='C:\Program Files\GPUbnb'
$output=Assert-Stage4NewOutput $OutputDirectory $installed
$names=@('gpubnb-agent.exe','gpubnb-windows-stream.exe','gpubnb-windows-worker.exe','GPUbnbWindowsMedia.dll')
$records=@()
foreach($n in $names){
    $path=Join-Path $installed $n
    if(-not (Test-Path -LiteralPath $path -PathType Leaf)){throw "stage4_backup_source_missing:$n"}
    $pe=Get-Stage4PeInfo $path
    $sig=Get-AuthenticodeSignature -LiteralPath $path
    $records+=@{name=$n;sha256=(Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant();
        architecture=$pe.architecture;sddl=(Get-Acl -LiteralPath $path).Sddl;
        signatureStatus=[string]$sig.Status;signerSha256=if($sig.SignerCertificate){$sig.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()}else{''}}
}
[void][IO.Directory]::CreateDirectory($output)
$complete=$false
try {
    foreach($r in $records){
        $src=Join-Path $installed $r.name;$dst=Join-Path $output $r.name
        Copy-Item -LiteralPath $src -Destination $dst
        if((Get-FileHash $src -Algorithm SHA256).Hash.ToLowerInvariant() -cne $r.sha256 -or
           (Get-FileHash $dst -Algorithm SHA256).Hash.ToLowerInvariant() -cne $r.sha256){throw "stage4_backup_changed_during_copy:$($r.name)"}
    }
    $services=@(Get-CimInstance Win32_Service|Where-Object {$_.Name -like '*GPUbnb*'}|Select-Object Name,State,StartMode,StartName,PathName,ProcessId)
    $manifest=[ordered]@{schemaVersion=1;kind='LOCAL_INSTALLED_COMPONENT_BACKUP';sourceDirectory=$installed;
        createdAtUtc=[DateTime]::UtcNow.ToString('o');files=$records;services=$services;
        directorySddl=(Get-Acl -LiteralPath $installed).Sddl;configurationFilesChanged=$false;
        privateKeyExported=$false;serviceModified=$false;installationPerformed=$false}
    $mp=Join-Path $output 'backup.manifest.json'
    [IO.File]::WriteAllText($mp,($manifest|ConvertTo-Json -Depth 10)+"`n",[Text.UTF8Encoding]::new($false))
    $complete=$true
    [ordered]@{ok=$true;outputDirectory=$output;filesVerified=4;
        backupManifestSha256=(Get-FileHash $mp -Algorithm SHA256).Hash.ToLowerInvariant();
        restorableWithoutFurtherChecks=$false;installationPerformed=$false} | ConvertTo-Json
}finally{
    if(-not $complete){[IO.File]::WriteAllText((Join-Path $output 'INCOMPLETE-BACKUP.txt'),'Backup failed. Never restore without a complete manifest and verified hashes.')}
}
