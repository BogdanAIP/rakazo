' Manual GUI entry point. WScript runs without a console; no startup/task/service registration.
' It launches the startup-status PowerShell GUI, which in turn starts the guarded Rakazo controller.
Option Explicit

Dim shell, fs, root, guiLauncher, powershell, commandLine, quote
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
guiLauncher = fs.BuildPath(root, "Launch-Rakazo-Gui.ps1")
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
quote = Chr(34)

If Not fs.FileExists(guiLauncher) Or Not fs.FileExists(powershell) Then
    WScript.Echo "Rakazo launcher is missing. No application was started."
    WScript.Quit 2
End If

commandLine = quote & powershell & quote & " -NoLogo -NoProfile -NonInteractive -Sta -WindowStyle Hidden -ExecutionPolicy Bypass -File " & quote & guiLauncher & quote

' The PowerShell host itself stays hidden. Launch-Rakazo-Gui.ps1 shows only the
' small startup-status window, then exits after tray active or after the user
' closes an error report. The actual Rakazo controller remains independent.
Dim controllerExit
On Error Resume Next
controllerExit = shell.Run(commandLine, 0, True)
If Err.Number <> 0 Then
    WScript.Echo "Rakazo could not start. Check the launcher files."
    WScript.Quit 1
End If
On Error GoTo 0

Dim stateFolder, exitLog
stateFolder = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Rakazo\manual-launcher"
On Error Resume Next
If fs.FolderExists(stateFolder) Then
    Set exitLog = fs.OpenTextFile(fs.BuildPath(stateFolder, "gui-exit.log"), 8, True)
    exitLog.WriteLine Now & " GUI startup window exit code: " & CStr(controllerExit)
    exitLog.Close
End If
On Error GoTo 0
WScript.Quit controllerExit
