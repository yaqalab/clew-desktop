; Clew's additions to electron-builder's NSIS installer (package.json build.nsis.include).

; Uninstalling, not updating (an update runs the old version's uninstaller too): what the app put
; outside its own folder goes with it. The data folder (%APPDATA%\Clew) and Documents\Clew stay,
; as the README says; Settings › General › Remove all Clew data deletes those.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Yaqatw for Word: the template in Word's Startup folder and the key it reads its token from
    ; (src/word-plugin.js). Word holding the template open keeps the file: say so.
    Delete "$APPDATA\Microsoft\Word\STARTUP\yaqatw.dotm"
    DeleteRegKey HKCU "Software\VB and VBA Program Settings\yaqatw\Clew"
    DeleteRegKey /ifempty HKCU "Software\VB and VBA Program Settings\yaqatw"
    ${if} ${FileExists} "$APPDATA\Microsoft\Word\STARTUP\yaqatw.dotm"
      ${ifNot} ${Silent}
        MessageBox MB_OK|MB_ICONINFORMATION "Word is open, so Yaqatw for Word could not be removed. Close Word, then delete$\r$\n$APPDATA\Microsoft\Word\STARTUP\yaqatw.dotm"
      ${endIf}
    ${endIf}
    ; Start at login (Electron's setLoginItemSettings: "electron.app.<product name>").
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.${PRODUCT_NAME}"
  ${endIf}
!macroend
