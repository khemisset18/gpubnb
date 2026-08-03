!include "LogicLib.nsh"

!macro GPUbnbExecChecked command failureMessage
  nsExec::ExecToStack '${command}'
  Pop $0
  Pop $1
  FileOpen $2 "$TEMP\gpubnb-installer.log" a
  FileWrite $2 "${failureMessage}: exit code $0$\r$\n$1$\r$\n"
  FileClose $2
  ${If} $0 != 0
    DetailPrint "${failureMessage}: exit code $0"
    DetailPrint "$1"
    Abort "${failureMessage}"
  ${EndIf}
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
    !insertmacro GPUbnbExecChecked '"$SYSDIR\sc.exe" delete GPUbnbAgent' "Unable to remove the previous GPUbnb service"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$%PROGRAMDATA%\GPUbnb"
  ; A bare %USERNAME% is not reliably resolvable on localized, domain-joined,
  ; Microsoft-account or Entra-joined Windows installations (Win32 error 1332).
  ; Qualifying it with USERDOMAIN keeps the ACL independent from translated
  ; built-in account names while granting access only to the installing user.
  !insertmacro GPUbnbExecChecked '"$SYSDIR\icacls.exe" "$%PROGRAMDATA%\GPUbnb" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "$%USERDOMAIN%\$%USERNAME%:(OI)(CI)M"' "Unable to secure the GPUbnb data directory"
  !insertmacro GPUbnbExecChecked '"$INSTDIR\gpubnb-agent.exe" service install' "Unable to install the GPUbnb Windows service"
  !insertmacro GPUbnbExecChecked '"$INSTDIR\gpubnb-agent.exe" service start' "Unable to start the GPUbnb Windows service"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop GPUbnbAgent'
  Sleep 2000
  !insertmacro GPUbnbExecChecked '"$INSTDIR\gpubnb-agent.exe" service remove' "Unable to remove the GPUbnb Windows service"
!macroend
