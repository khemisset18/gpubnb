#Requires -Version 5.1
# Read-only inventory. No helper/worker execution, GPU probe, service or WTS mutation.
[CmdletBinding()]
param(
    [string]$ExpectedGpuUuid='GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a',
    [string]$RenterAccount='gpubnb-renter-qual',
    [string]$PublisherSha256='200208e0ef9dc3de4911df5541e6b11506c07de2820849006311cb68b342965a'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess){throw 'stage4_windows_x64_required'}
. (Join-Path $PSScriptRoot 'stage4-package-common.ps1')
$checks=@();$observations=[ordered]@{}
function Record([string]$Name,[bool]$Pass,[string]$Detail){$script:checks+=@{name=$Name;pass=$Pass;detail=$Detail}}
try {
    $gpu=@(& nvidia-smi --query-gpu=name,uuid,driver_version --format=csv,noheader 2>&1)
    if($LASTEXITCODE -ne 0){throw 'stage4_nvidia_inventory_failed'}
    $matches=@($gpu|Where-Object {$_ -match [regex]::Escape($ExpectedGpuUuid)})
    $fields=if($matches.Count -eq 1){@($matches[0] -split ',\s*')}else{@()}
    $pass=$fields.Count -eq 3 -and $fields[0] -match 'GTX 1650' -and [version]$fields[2] -ge [version]'570.00'
    Record 'GTX1650-exact-UUID-driver-570-or-newer' $pass ($gpu -join '; ')
    $observations.gpus=$gpu
}catch{Record 'GTX1650-exact-UUID-driver-570-or-newer' $false $_.Exception.Message}
foreach($dll in @('nvEncodeAPI64.dll','nvcuda.dll')){
    $path=Join-Path ([Environment]::SystemDirectory) $dll
    Record ('NVIDIA-runtime-'+$dll) (Test-Path -LiteralPath $path -PathType Leaf) $path
}
try {
    $idd=@(Get-PnpDevice -PresentOnly|Where-Object {$_.FriendlyName -ceq 'GPUbnb Isolated Virtual Display'})
    $observations.idd=@($idd|Select-Object FriendlyName,InstanceId,Status)
    Record 'IddCx-existing-device-OK' ($idd.Count -eq 1 -and $idd[0].Status -eq 'OK') ($observations.idd|ConvertTo-Json -Compress)
}catch{Record 'IddCx-existing-device-OK' $false $_.Exception.Message}
try {
    $certs=@(Get-ChildItem Cert:\CurrentUser\My|Where-Object {$_.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() -ceq $PublisherSha256})
    if($certs.Count -ne 1){throw 'stage4_private_test_certificate_unavailable'}
    Assert-Stage4Certificate $certs[0] $PublisherSha256
    Record 'exact-test-certificate-key-EKU-chain-dates' $true ('NotAfterUTC='+$certs[0].NotAfter.ToUniversalTime().ToString('o'))
}catch{Record 'exact-test-certificate-key-EKU-chain-dates' $false $_.Exception.Message}
try {
    $user=Get-LocalUser -Name $RenterAccount
    $provider=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $observations.renter=@{name=$user.Name;sid=$user.SID.Value;enabled=$user.Enabled;auditorSid=$provider}
    Record 'enabled-renter-account-distinct-from-auditor' ($user.Enabled -and $user.SID.Value -cne $provider) ($observations.renter|ConvertTo-Json -Compress)
}catch{Record 'enabled-renter-account-distinct-from-auditor' $false $_.Exception.Message}
try {
    if(-not ('Stage4ReadOnlyWts' -as [type])){
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Stage4ReadOnlyWts {
  [StructLayout(LayoutKind.Sequential)] struct Session { public int Id; public IntPtr Station; public int State; }
  public class Row { public int sessionId; public int state; public string user; public string domain; public bool activeConsole; }
  [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode)] static extern bool WTSEnumerateSessionsW(IntPtr server,int reserved,int version,out IntPtr rows,out int count);
  [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode)] static extern bool WTSQuerySessionInformationW(IntPtr server,int id,int info,out IntPtr value,out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr value);
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
  static string Query(int id,int info) { IntPtr p; int n; if(!WTSQuerySessionInformationW(IntPtr.Zero,id,info,out p,out n))throw new InvalidOperationException("WTS query failed"); try{return Marshal.PtrToStringUni(p)??"";}finally{WTSFreeMemory(p);} }
  public static Row[] Read() { IntPtr p; int n; if(!WTSEnumerateSessionsW(IntPtr.Zero,0,1,out p,out n))throw new InvalidOperationException("WTS enumeration failed");
    try {var rows=new List<Row>();int size=Marshal.SizeOf(typeof(Session));for(int i=0;i<n;i++){var s=(Session)Marshal.PtrToStructure(IntPtr.Add(p,i*size),typeof(Session));rows.Add(new Row{sessionId=s.Id,state=s.State,user=Query(s.Id,5),domain=Query(s.Id,7),activeConsole=((uint)s.Id==WTSGetActiveConsoleSessionId())});}return rows.ToArray();}finally{WTSFreeMemory(p);} }
}
'@
    }
    $sessions=@([Stage4ReadOnlyWts]::Read())
    $observations.wts=$sessions
    $active=@($sessions|Where-Object {$_.sessionId -ne 0 -and $_.state -eq 0})
    $isolated=$active.Count -eq 1 -and $active[0].user -ceq $RenterAccount -and $active[0].activeConsole
    Record 'exclusive-active-renter-console-session' $isolated ($sessions|ConvertTo-Json -Compress)
}catch{Record 'exclusive-active-renter-console-session' $false $_.Exception.Message}
try {
    $processes=@(Get-CimInstance Win32_Process|Where-Object {$_.Name -match '^gpubnb-(agent|windows-stream|windows-worker)\.exe$'}|Select-Object ProcessId,ParentProcessId,SessionId,Name,ExecutablePath)
    $services=@(Get-CimInstance Win32_Service|Where-Object {$_.Name -like '*GPUbnb*'}|Select-Object Name,State,StartMode,ProcessId,PathName,StartName)
    $observations.processes=$processes;$observations.services=$services
    # Stopped is an observation, not an inferred fault. PID/path correlation is
    # preserved for explicit operator review before any future replacement.
    Record 'Agent-service-PID-path-inventory' $true ('processes='+$processes.Count+'; services='+$services.Count+'; no restart requested')
}catch{Record 'Agent-service-PID-path-inventory' $false $_.Exception.Message}
[ordered]@{kind='STAGE4_READ_ONLY_PC1_INVENTORY';observedAtUtc=[DateTime]::UtcNow.ToString('o');checks=$checks;
    observations=$observations;preconditionsObserved=(@($checks|Where-Object {-not $_.pass}).Count -eq 0);
    hardwareQualified=$false;nvencEncodingTestPerformed=$false;iddAbiPhysicallyVerified=$false;
    installationPerformed=$false;serviceModified=$false;certificateStoreModified=$false} | ConvertTo-Json -Depth 12
