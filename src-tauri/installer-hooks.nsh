; Дополнения к установщику Tauri.
;
; Переход с Electron-версии (1.x): она сама скачивает этот установщик через electron-updater
; и запускает его как "Setup.exe --updated /S [--force-run]". Старую копию тихо удаляем,
; настройки, вход и свои файлы остаются в %APPDATA%\Zvuk Glass.

!macro NSIS_HOOK_PREINSTALL
  StrCpy $R9 "$LOCALAPPDATA\Programs\zvuk-glass"
  ${If} ${FileExists} "$R9\Uninstall Zvuk Glass.exe"
    nsExec::Exec 'taskkill /F /IM "Zvuk Glass.exe"'
    Pop $R8
    ; _?= — удалять на месте и дождаться окончания (иначе деинсталлятор копирует себя и возвращается сразу)
    ExecWait '"$R9\Uninstall Zvuk Glass.exe" /S _?=$R9'
    Delete "$R9\Uninstall Zvuk Glass.exe"
    RMDir /r "$R9"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; electron-updater просит запустить приложение флагом --force-run (кнопка «Перезапустить»)
  ClearErrors
  ${GetOptions} $CMDLINE "--force-run" $R0
  ${IfNot} ${Errors}
    ClearErrors
    ${GetOptions} $CMDLINE "/R" $R0
    ${If} ${Errors}
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
    ${EndIf}
  ${EndIf}
!macroend
