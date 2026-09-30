# Rakazo-owned Windows desktop backend. Reads one bounded JSON request from stdin.
# No HTTP listener, credentials, planner, dynamic PowerShell source or independent LLM.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RakazoWin32 {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, int data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int max);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@

function Get-DesktopSnapshot {
    $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
    if ($screen.Width -lt 1 -or $screen.Height -lt 1 -or $screen.Width -gt 10000 -or $screen.Height -gt 10000) {
        throw "Invalid Windows virtual-screen dimensions"
    }
    $bitmap = [System.Drawing.Bitmap]::new($screen.Width, $screen.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $buffer = New-Object System.IO.MemoryStream
    try {
        $graphics.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $bitmap.Size)
        $bitmap.Save($buffer, [System.Drawing.Imaging.ImageFormat]::Png)
        if ($buffer.Length -gt 6000000) { throw "Windows screen capture exceeds 6 MB" }
        $pointer = New-Object RakazoWin32+POINT
        [void][RakazoWin32]::GetCursorPos([ref]$pointer)
        $window = [RakazoWin32]::GetForegroundWindow()
        $windowTitle = New-Object System.Text.StringBuilder(512)
        [void][RakazoWin32]::GetWindowText($window, $windowTitle, $windowTitle.Capacity)
        return @{
            imageBase64 = [Convert]::ToBase64String($buffer.ToArray())
            mimeType = "image/png"
            width = $screen.Width
            height = $screen.Height
            cursor = @{ x = $pointer.X - $screen.Left; y = $pointer.Y - $screen.Top }
            activeWindow = @{ id = $window.ToInt64().ToString(); title = $windowTitle.ToString() }
        }
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
        $buffer.Dispose()
    }
}

function Set-DesktopKey($action) {
    $keyName = [string]$action.key
    $keys = @{
        Return=13; Enter=13; Tab=9; Escape=27; Esc=27; Backspace=8; Delete=46
        Space=32; Left=37; Up=38; Right=39; Down=40; Home=36; End=35
        PageUp=33; PageDown=34; Insert=45
    }
    for ($i = 1; $i -le 12; $i++) { $keys["F" + $i] = 111 + $i }
    if ($keys.ContainsKey($keyName)) { $vk = [int]$keys[$keyName] }
    elseif ($keyName.Length -eq 1 -and $keyName -match '^[A-Za-z0-9]$') {
        $vk = [int][char]$keyName.ToUpperInvariant()
    }
    else { throw "Unsupported Windows key" }
    $modifiers = @()
    if ($action.modifiers) {
        foreach ($name in @($action.modifiers)) {
            switch ([string]$name) {
            "Control" { $modifiers += 17 }
            "Ctrl" { $modifiers += 17 }
            "Shift" { $modifiers += 16 }
            "Alt" { $modifiers += 18 }
            "Meta" { $modifiers += 91 }
            "Win" { $modifiers += 91 }
            default { throw "Unsupported Windows modifier" }
            }
        }
    }
    try {
        foreach ($modifier in $modifiers) {
            [RakazoWin32]::keybd_event([byte]$modifier, 0, 0, [UIntPtr]::Zero)
        }
        [RakazoWin32]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
        [RakazoWin32]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
    }
    finally {
        [array]::Reverse($modifiers)
        foreach ($modifier in $modifiers) {
            [RakazoWin32]::keybd_event([byte]$modifier, 0, 2, [UIntPtr]::Zero)
        }
    }
}

function Invoke-DesktopAction($action) {
    switch ([string]$action.kind) {
        "key" { Set-DesktopKey $action }
        "clipboard" {
            if ([string]::IsNullOrEmpty([string]$action.text)) {
                [System.Windows.Forms.Clipboard]::Clear()
            } else {
                [System.Windows.Forms.Clipboard]::SetText([string]$action.text)
                Set-DesktopKey ([pscustomobject]@{ key="v"; modifiers=@("Control") })
            }
        }
        "pointer" {
            $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
            $x = [int]$action.x
            $y = [int]$action.y
            if ($x -lt 0 -or $y -lt 0 -or $x -ge $screen.Width -or $y -ge $screen.Height) {
                throw "Pointer location is outside the Windows virtual screen"
            }
            [void][RakazoWin32]::SetCursorPos($screen.Left + $x, $screen.Top + $y)
            $left = [string]$action.button -ne "right"
            $down = [uint32]$(if ($left) { 2 } else { 8 })
            $up = [uint32]$(if ($left) { 4 } else { 16 })
            switch ([string]$action.type) {
                "move" { }
                "down" { [RakazoWin32]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero) }
                "up" { [RakazoWin32]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero) }
                "click" {
                    [RakazoWin32]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
                    [RakazoWin32]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
                }
                default { throw "Unsupported pointer action" }
            }
        }
        "scroll" {
            $steps = [Math]::Min([Math]::Max([int]$action.amount, 1), 20)
            $delta = $(if ([string]$action.direction -eq "up") { $steps * 120 } else { -$steps * 120 })
            [RakazoWin32]::mouse_event(2048, 0, 0, $delta, [UIntPtr]::Zero)
        }
        "wait" {
            $ms = [Math]::Min([Math]::Max([int]$action.ms, 0), 5000)
            Start-Sleep -Milliseconds $ms
        }
        default { throw "Unsupported physical Windows action" }
    }
}

$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
switch ([string]$request.command) {
    "observe" {
        $result = @{ kind = "observation"; observation = Get-DesktopSnapshot }
    }
    "act" {
        if ($request.actions.Count -gt 24) { throw "Too many Windows desktop actions" }
        $completed = 0
        foreach ($action in @($request.actions)) {
            Invoke-DesktopAction $action
            $completed++
        }
        if ($request.settleMs) {
            Start-Sleep -Milliseconds ([Math]::Min([Math]::Max([int]$request.settleMs, 0), 5000))
        }
        $result = @{ kind = "actions"; completed = $completed }
        if ($request.observe -ne $false) {
            $result.observation = Get-DesktopSnapshot
        }
    }
    default { throw "Unknown Windows GUI request" }
}
[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 8 -Compress))
