; polyclaude NSIS customizations (included by electron-builder).
; Offers to install the command-line tools (pcc / polyclaude) during setup, so
; the desktop app and the CLI can be installed together in one go. The actual
; work is done by the app itself (`--install-cli`), keeping the logic in one
; place (src/main/cli-install.ts) and shared with the in-app "Install pcc" button.

!macro customInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "Also install the polyclaude command-line tools?$\n$\nThis adds 'pcc' and 'polyclaude' to your PATH so you can use them from any terminal." IDNO skip_cli_install
    DetailPrint "Installing polyclaude command-line tools…"
    nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --install-cli'
  skip_cli_install:
!macroend

!macro customUnInstall
  ; Best-effort: let the app clean up PATH + shims, then remove the bin dir.
  nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-cli'
  RMDir /r "$PROFILE\.polyclaude\bin"
!macroend
