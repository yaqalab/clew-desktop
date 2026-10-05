; The installer for the Clew audio server (Inno Setup 6). Built by installer\build-installer.cmd.
;
; Per user, no administrator rights: the program goes to %LOCALAPPDATA%\Programs\Clew Audio Server,
; a Start menu entry, and optionally starts with Windows (the same registry value the settings
; window's "Start with Windows" uses). Uninstalling quits the running program and removes it; the
; settings (folder, port, sealed secret) stay in %APPDATA%\clew-audio-server unless the user says to
; remove them. Converted copies live in the audio folder itself (.clew-converted) and are left there:
; they belong with the recordings.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define AppExe "clew-audio-server.exe"

[Setup]
AppId={{6F3C1E2A-8B4D-4C9E-9A57-2D1B7E0C4F93}
AppName=Clew Audio Server
AppVersion={#AppVersion}
AppVerName=Clew Audio Server {#AppVersion}
AppPublisher=YaqaLab
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\Clew Audio Server
DefaultGroupName=Clew
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\dist
OutputBaseFilename=clew-audio-server-setup-{#AppVersion}
SetupIconFile=..\res\icons\app.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName=Clew Audio Server
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Signed with the YaqaLab certificate when build-installer.cmd finds one (it defines Sign and the
; "yaqalab" sign tool); the uninstaller is signed too.
#ifdef Sign
SignTool=yaqalab
SignedUninstaller=yes
#endif
; Close a running copy before files are replaced (it answers the session-end messages).
CloseApplications=yes
RestartApplications=no
AppMutex=Local\ClewAudioServer.SingleInstance

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "ja"; MessagesFile: "compiler:Languages\Japanese.isl"

[CustomMessages]
en.AutostartTask=Start the audio server with Windows
ja.AutostartTask=Windows の起動時にオーディオサーバーを開始する
en.StartNow=Start the Clew audio server now
ja.StartNow=Clew オーディオサーバーを今すぐ開始する
en.RemoveSettings=Also remove the settings (the chosen folder, the port and the secret)?%n%nKeep them if you will install the audio server again: Clew can then go on using the same secret.
ja.RemoveSettings=設定（選択したフォルダー、ポート、シークレット）も削除しますか？%n%n再インストールする予定がある場合は残してください。Clew は同じシークレットを使い続けられます。

[Tasks]
Name: "autostart"; Description: "{cm:AutostartTask}"
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\build\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; DestName: "README.txt"; Flags: ignoreversion

[Icons]
Name: "{group}\Clew Audio Server"; Filename: "{app}\{#AppExe}"
Name: "{group}\{cm:UninstallProgram,Clew Audio Server}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Clew Audio Server"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "ClewAudioServer"; ValueData: """{app}\{#AppExe}"""; Tasks: autostart; Flags: uninsdeletevalue

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:StartNow}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\{#AppExe}"; Parameters: "--quit"; RunOnceId: "QuitServer"; Flags: runhidden waituntilterminated

[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  // The "Start with Windows" value may have been set from the window, not by this installer.
  if CurUninstallStep = usUninstall then
    RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'ClewAudioServer');
  if (CurUninstallStep = usPostUninstall) and not UninstallSilent then
    if MsgBox(CustomMessage('RemoveSettings'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(ExpandConstant('{userappdata}\clew-audio-server\settings.json'), False, True, False);
end;
