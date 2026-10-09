!include "LogicLib.nsh"

!macro GPUbnbExecChecked command failureMessage
  nsExec::ExecToStack '${command}'
  Pop $0
  Pop $1
  FileOpen $2 "$TEMP\gpubnb-installer.log" a
  FileWrite $2 "Command exit code $0$\r$\n$1$\r$\n"
  FileClose $2
  ${If} $0 != 0
    DetailPrint "${failureMessage}: exit code $0"
    DetailPrint "$1"
    Abort "${failureMessage}"
  ${EndIf}
!macroend

!macro GPUbnbForceKillAgent
  ; A hung service may outlive sc.exe stop. Never fall back to taskkill /IM:
  ; another process with the same filename is not part of the GPUbnb service
  ; authority. Resolve the exact SCM-owned PID, prove its executable path is
  ; the executable registered in the service command line, and only then stop
  ; that one process. Any ambiguity aborts the install/update fail-closed.
  FileOpen $2 "$TEMP\gpubnb-stop-agent-service-pid.ps1" w
  FileWrite $2 "$$ErrorActionPreference = 'Stop'$\r$\n"
  FileWrite $2 "$$service = Get-CimInstance Win32_Service -Filter 'Name=''GPUbnbAgent''' -ErrorAction SilentlyContinue$\r$\n"
  FileWrite $2 "if ($$null -eq $$service -or [uint32]$$service.ProcessId -eq 0) { exit 0 }$\r$\n"
  FileWrite $2 "$$servicePid = [uint32]$$service.ProcessId$\r$\n"
  FileWrite $2 "$$pathName = ([string]$$service.PathName).Trim()$\r$\n"
  FileWrite $2 "if ([string]::IsNullOrWhiteSpace($$pathName)) { throw 'GPUbnbAgent service path is unavailable.' }$\r$\n"
  FileWrite $2 "if ($$pathName.StartsWith([string][char]34)) {$\r$\n"
  FileWrite $2 "  $$endQuote = $$pathName.IndexOf([char]34, 1)$\r$\n"
  FileWrite $2 "  if ($$endQuote -lt 2) { throw 'GPUbnbAgent service path is malformed.' }$\r$\n"
  FileWrite $2 "  $$expectedExe = $$pathName.Substring(1, $$endQuote - 1)$\r$\n"
  FileWrite $2 "} else {$\r$\n"
  FileWrite $2 "  $$exeEnd = $$pathName.IndexOf('.exe', [System.StringComparison]::OrdinalIgnoreCase)$\r$\n"
  FileWrite $2 "  if ($$exeEnd -lt 0) { throw 'GPUbnbAgent service path has no executable.' }$\r$\n"
  FileWrite $2 "  $$expectedExe = $$pathName.Substring(0, $$exeEnd + 4).Trim()$\r$\n"
  FileWrite $2 "}$\r$\n"
  FileWrite $2 "if ([IO.Path]::GetFileName($$expectedExe) -ine 'gpubnb-agent.exe') { throw 'GPUbnbAgent service executable name mismatch.' }$\r$\n"
  FileWrite $2 "$$processFilter = 'ProcessId=' + $$servicePid$\r$\n"
  FileWrite $2 "$$process = Get-CimInstance Win32_Process -Filter $$processFilter -ErrorAction Stop$\r$\n"
  FileWrite $2 "if ($$null -eq $$process) { exit 0 }$\r$\n"
  FileWrite $2 "$$actualExe = [string]$$process.ExecutablePath$\r$\n"
  FileWrite $2 "if ([string]::IsNullOrWhiteSpace($$actualExe)) { throw 'GPUbnbAgent process path is unavailable.' }$\r$\n"
  FileWrite $2 "$$expectedFull = [IO.Path]::GetFullPath($$expectedExe)$\r$\n"
  FileWrite $2 "$$actualFull = [IO.Path]::GetFullPath($$actualExe)$\r$\n"
  FileWrite $2 "if (-not [string]::Equals($$expectedFull, $$actualFull, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'GPUbnbAgent service/process executable mismatch.' }$\r$\n"
  FileWrite $2 "Stop-Process -Id $$servicePid -Force -ErrorAction Stop$\r$\n"
  FileWrite $2 "$$deadline = (Get-Date).AddSeconds(15)$\r$\n"
  FileWrite $2 "while (Get-Process -Id $$servicePid -ErrorAction SilentlyContinue) {$\r$\n"
  FileWrite $2 "  if ((Get-Date) -ge $$deadline) { throw 'GPUbnbAgent process did not exit after targeted stop.' }$\r$\n"
  FileWrite $2 "  Start-Sleep -Milliseconds 200$\r$\n"
  FileWrite $2 "}$\r$\n"
  FileClose $2
  !insertmacro GPUbnbExecChecked '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\gpubnb-stop-agent-service-pid.ps1"' "Unable to stop the verified GPUbnb service process"
  Delete "$TEMP\gpubnb-stop-agent-service-pid.ps1"
!macroend

!macro NSIS_HOOK_PREINSTALL
  Delete "$TEMP\gpubnb-installer.log"
  ; An existing service must release the sidecar before an upgrade can replace it.
  nsExec::ExecToStack '"$SYSDIR\sc.exe" query GPUbnbAgent'
  Pop $0
  Pop $1
  ${If} $0 == 0
    nsExec::ExecToLog '"$SYSDIR\sc.exe" stop GPUbnbAgent'
    Sleep 2000
    !insertmacro GPUbnbForceKillAgent
    !insertmacro GPUbnbExecChecked '"$SYSDIR\sc.exe" delete GPUbnbAgent' "Unable to remove the previous GPUbnb service"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$%PROGRAMDATA%\GPUbnb"
  ; Resolve the installing principal directly to its SID. Account-name based
  ; ACLs fail with Win32 error 1332 on some localized, Microsoft-account and
  ; Entra-joined Windows installations even when USERDOMAIN is supplied.
  FileOpen $2 "$TEMP\gpubnb-secure-data-directory.ps1" w
  FileWrite $2 "$$ErrorActionPreference = 'Stop'$\r$\n"
  FileWrite $2 "$$path = Join-Path $$env:ProgramData 'GPUbnb'$\r$\n"
  FileWrite $2 "$$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User$\r$\n"
  FileWrite $2 "if ($$null -eq $$currentSid) { throw 'Current Windows SID is unavailable.' }$\r$\n"
  FileWrite $2 "$$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')$\r$\n"
  FileWrite $2 "$$administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')$\r$\n"
  FileWrite $2 "$$acl = [System.Security.AccessControl.DirectorySecurity]::new()$\r$\n"
  FileWrite $2 "$$acl.SetAccessRuleProtection($$true, $$false)$\r$\n"
  FileWrite $2 "$$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit$\r$\n"
  FileWrite $2 "$$propagation = [System.Security.AccessControl.PropagationFlags]::None$\r$\n"
  FileWrite $2 "$$allow = [System.Security.AccessControl.AccessControlType]::Allow$\r$\n"
  FileWrite $2 "$$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($$systemSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $$inheritance, $$propagation, $$allow))$\r$\n"
  FileWrite $2 "$$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($$administratorsSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $$inheritance, $$propagation, $$allow))$\r$\n"
  FileWrite $2 "$$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($$currentSid, [System.Security.AccessControl.FileSystemRights]::Modify, $$inheritance, $$propagation, $$allow))$\r$\n"
  FileWrite $2 "[System.IO.Directory]::SetAccessControl($$path, $$acl)$\r$\n"
  FileClose $2
  !insertmacro GPUbnbExecChecked '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\gpubnb-secure-data-directory.ps1"' "Unable to secure the GPUbnb data directory"
  Delete "$TEMP\gpubnb-secure-data-directory.ps1"
  !insertmacro GPUbnbExecChecked '"$INSTDIR\gpubnb-agent.exe" service install' "Unable to install the GPUbnb Windows service"
  !insertmacro GPUbnbExecChecked '"$INSTDIR\gpubnb-agent.exe" service start' "Unable to start the GPUbnb Windows service"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop GPUbnbAgent'
  Sleep 2000
  !insertmacro GPUbnbForceKillAgent
  !insertmacro GPUbnbExecChecked '"$INSTDIR\gpubnb-agent.exe" service remove' "Unable to remove the GPUbnb Windows service"
!macroend
