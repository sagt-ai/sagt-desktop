; After a normal uninstall, open a page that asks why Sagt was uninstalled.
; (The file is kept ASCII-only so the NSIS compiler reads it the same way
; whatever input charset it is given.)
;
; Only for an uninstall the user started:
; - not in silent mode (/S), used by scripts and automated installs,
; - not in passive mode (/P),
; - not when the app updates itself (/UPDATE). Updates do not run the
;   uninstaller today, but the guard stays in case that changes.
;
; The page opens in the user's browser. The address carries only the
; operating system and the version, nothing that identifies the user.
!macro NSIS_HOOK_POSTUNINSTALL
  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode <> 1
  ${AndIf} $UpdateMode <> 1
    ExecShell "open" "https://sagt.ai/hejda?os=windows&version=${VERSION}"
  ${EndIf}
!macroend
