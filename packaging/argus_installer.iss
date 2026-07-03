; Inno Setup script for ARGUS (Phase #5 installer).
; Wraps the PyInstaller one-dir bundle (packaging/dist/ARGUS) into a single ARGUS_Setup.exe that
; installs to Program Files, adds Start-Menu + optional desktop shortcuts, and can launch ARGUS
; (which starts the local server and opens in its own standalone app window). Zero external
; dependencies — runs on the bundled SQLite database out of the box, fitting the air-gapped
; deployment.
;
; Build: install Inno Setup, open this file, and Compile (or `iscc argus_installer.iss`).

#define AppName "ARGUS"
#define AppVersion "1.0.0"
#define AppPublisher "GPCSSI"
#define AppExe "ARGUS.exe"
#define BootstrapUser "admin"
#define BootstrapPassword "admin12345"

[Setup]
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
OutputBaseFilename=ARGUS_Setup
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
DisableProgramGroupPage=yes
WizardStyle=modern
; Branding — the exe icon (taskbar/Explorer/uninstaller), the tall banner on the
; Welcome/Finished pages, and the small mark on every inner wizard page. Regenerate from
; backend/static/logo-mark.png + logo-readme.png via the one-off script noted in assets/README.
SetupIconFile=assets\logo.ico
WizardImageFile=assets\wizard_large.bmp
WizardSmallImageFile=assets\wizard_small.bmp
UninstallDisplayIcon={app}\{#AppExe}

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Files]
; Ship the entire PyInstaller one-dir output.
Source: "dist\ARGUS\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName} now"; Flags: nowait postinstall skipifsilent

[Messages]
; Overrides the default Finished-page text — the same page as the "Launch ARGUS now" checkbox
; above — with the bootstrap sign-in so it's the last thing the operator sees before launching.
; These are the zero-config defaults from AUTH_BOOTSTRAP_USERNAME/AUTH_BOOTSTRAP_PASSWORD
; (backend/app/core/config.py); change them from the Admin tab right after first login.
FinishedLabel=Setup has finished installing {#AppName} on your computer.%n%nSign in with the default account:%n%n     Username:  {#BootstrapUser}%n     Password:  {#BootstrapPassword}%n%nChange this password immediately after your first login (Admin tab).%n%nClick Finish to launch {#AppName}.
