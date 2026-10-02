' Manual GUI entry point. WScript runs without a console; no startup/task/service registration.
' Reuse the existing PowerShell controller and its single-instance mutex and R ownership gates.
Option Explicit

Dim shell, fs, root, launcher, powershell, commandLine, quote
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
launcher = fs.BuildPath(root, "Rakazo.ps1")
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
quote = Chr(34)

If Not fs.FileExists(launcher) Or Not fs.FileExists(powershell) Then
    WScript.Echo "Rakazo launcher is missing. No application was started."
    WScript.Quit 2
End If

commandLine = quote & powershell & quote & " -NoLogo -NoProfile -NonInteractive -Sta -WindowStyle Hidden -ExecutionPolicy Bypass -File " & quote & launcher & quote & " -Action Run"
' Keep the invisible GUI host alive while the controller runs. An asynchronous
' host exits immediately and gives us no exit code or lifetime evidence.
Dim controllerExit
On Error Resume Next
controllerExit = shell.Run(commandLine, 0, True)
If Err.Number <> 0 Then
    WScript.Echo "Rakazo could not start. Check the launcher files."
    WScript.Quit 1
End If
On Error GoTo 0

' No secret material or command line is logged. Errors from the controller
' itself are recorded by its stage logger; this exit code is supplementary.
Dim stateFolder, exitLog
stateFolder = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Rakazo\manual-launcher"
On Error Resume Next
If fs.FolderExists(stateFolder) Then
    Set exitLog = fs.OpenTextFile(fs.BuildPath(stateFolder, "gui-exit.log"), 8, True)
    exitLog.WriteLine Now & " GUI controller exit code: " & CStr(controllerExit)
    exitLog.Close
End If
On Error GoTo 0
WScript.Quit controllerExit
