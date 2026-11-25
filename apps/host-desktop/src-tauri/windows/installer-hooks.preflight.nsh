; This hook is only selected by tauri.preflight.conf.json in disposable CI.
; It embeds unsigned files for install/uninstall smoke coverage and must never
; be used to build a user-facing or release installer.
!define GPUBNB_PREFLIGHT_INSTALLER
!include "${__FILEDIR__}\installer-hooks.nsh"
