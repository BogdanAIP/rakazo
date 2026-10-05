# Rakazo-owned read-only Windows UI Automation snapshot.
# Enumerates only the current foreground window. No ValuePattern reads and no actions.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RakazoUiaWin32 {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr window, StringBuilder text, int max);
}
"@

$maxNodes = 400
$maxDepth = 8

function Limit-UiaText($value, [int]$maxLength) {
    if ($null -eq $value) { return "" }
    $text = [string]$value
    if ($text.Length -le $maxLength) { return $text }
    return $text.Substring(0, $maxLength)
}

function Limit-UiaNumber([double]$value, [double]$minimum, [double]$maximum) {
    if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { return 0 }
    return [Math]::Round([Math]::Min([Math]::Max($value, $minimum), $maximum), 2)
}

$handle = [RakazoUiaWin32]::GetForegroundWindow()
if ($handle -eq [IntPtr]::Zero) { throw "No foreground Windows UI is available" }

$title = New-Object System.Text.StringBuilder(512)
[void][RakazoUiaWin32]::GetWindowText($handle, $title, $title.Capacity)

$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if ($null -eq $root) { throw "Foreground window is unavailable to UI Automation" }

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$nodes = New-Object System.Collections.Generic.List[object]
$stack = New-Object System.Collections.Stack
$stack.Push([pscustomobject]@{ Element = $root; Depth = 0; ParentRef = $null })
$nextRef = 1
$truncated = $false

while ($stack.Count -gt 0) {
    if ($nodes.Count -ge $maxNodes) {
        $truncated = $true
        break
    }

    $item = $stack.Pop()
    $element = $item.Element
    try {
        $current = $element.Current
        $programmatic = Limit-UiaText $current.ControlType.ProgrammaticName 128
        $controlType = $programmatic
        if ($controlType.StartsWith("ControlType.")) {
            $controlType = $controlType.Substring("ControlType.".Length)
        }
        if ([string]::IsNullOrWhiteSpace($controlType)) { $controlType = "Unknown" }

        $ref = "u$nextRef"
        $nextRef++
        $node = [ordered]@{
            ref = $ref
            depth = [int]$item.Depth
            controlType = $controlType
            name = Limit-UiaText $current.Name 512
            enabled = [bool]$current.IsEnabled
            focusable = [bool]$current.IsKeyboardFocusable
            offscreen = [bool]$current.IsOffscreen
        }
        if ($item.ParentRef) { $node.parentRef = [string]$item.ParentRef }

        $automationId = Limit-UiaText $current.AutomationId 512
        if (-not [string]::IsNullOrWhiteSpace($automationId)) {
            $node.automationId = $automationId
        }

        try {
            $rect = $current.BoundingRectangle
            if ($rect.Width -ge 0 -and $rect.Height -ge 0) {
                $node.bounds = @{
                    x = Limit-UiaNumber $rect.X -100000 100000
                    y = Limit-UiaNumber $rect.Y -100000 100000
                    width = Limit-UiaNumber $rect.Width 0 100000
                    height = Limit-UiaNumber $rect.Height 0 100000
                }
            }
        } catch { }

        $nodes.Add([pscustomobject]$node)

        if ([int]$item.Depth -lt $maxDepth) {
            $children = @()
            try {
                $child = $walker.GetFirstChild($element)
                while ($null -ne $child) {
                    $children += ,$child
                    $child = $walker.GetNextSibling($child)
                }
            } catch { }
            for ($index = $children.Count - 1; $index -ge 0; $index--) {
                $stack.Push([pscustomobject]@{
                    Element = $children[$index]
                    Depth = ([int]$item.Depth + 1)
                    ParentRef = $ref
                })
            }
        }
    } catch {
        # Elements can disappear while the UI changes; skip only that element.
    }
}

$result = @{
    activeWindow = @{
        id = $handle.ToInt64().ToString()
        title = Limit-UiaText $title.ToString() 512
    }
    nodes = $nodes.ToArray()
    truncated = $truncated
}
[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 8 -Compress))
