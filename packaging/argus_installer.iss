; Inno Setup script for ARGUS (Phase #5 installer).
; Wraps the PyInstaller one-dir bundle (packaging/dist/ARGUS) into a single ARGUS_Setup.exe that
; installs to Program Files, adds Start-Menu + optional desktop shortcuts, and can launch ARGUS
; (which starts the local server and opens the browser). Zero external dependencies — runs on the
; bundled SQLite database out of the box, fitting the air-gapped deployment.
;
; Build: install Inno Setup, open this file, and Compile (or `iscc argus_installer.iss`).

#define AppName "ARGUS"
#define AppVersion "1.0.0"
#define AppPublisher "GPCSSI"
#define AppExe "ARGUS.exe"

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
