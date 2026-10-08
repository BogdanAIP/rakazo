function Add-RakazoNativeUpdateMenu {
    param($Menu, $Context, [string]$Repo, [string]$Updater)
    $guard = [pscustomobject]@{ Busy = $false }
    $check = $Menu.Items.Add('Check GitHub updates')
    $update = $Menu.Items.Add('Update from GitHub')
    $check.add_Click({
        if ($guard.Busy) { return }
        $guard.Busy = $true
        try {
            $plan = & $Updater -Action Check -Repo $Repo | ConvertFrom-Json
            $details = if ($plan.reason) { $plan.reason } elseif ($plan.status -eq 'current') {
                'Already up to date.'
            } else { 'A fast-forward update is available.' }
            $message = @(
                "Branch: $($plan.branch)"
                "Local: $($plan.head.Substring(0,8))"
                "Remote: $($plan.target.Substring(0,8))"
                "Files changed: $(@($plan.changedFiles).Count)"
                $details
            ) -join [Environment]::NewLine
            [System.Windows.Forms.MessageBox]::Show($message, 'Rakazo updates') | Out-Null
        } catch {
            [System.Windows.Forms.MessageBox]::Show('Update check failed. No application files were changed.', 'Rakazo updates') | Out-Null
        } finally { $guard.Busy = $false }
    }.GetNewClosure())
    $update.add_Click({
        if ($guard.Busy) { return }
        $guard.Busy = $true
        try {
            $plan = & $Updater -Action Check -Repo $Repo | ConvertFrom-Json
            if ($plan.status -ne 'available') {
                $message = if ($plan.reason) { $plan.reason } else { 'No new commits.' }
                [System.Windows.Forms.MessageBox]::Show($message, 'Rakazo updates') | Out-Null
                return
            }
            $response = [System.Windows.Forms.MessageBox]::Show(
                "Update Rakazo to $($plan.target.Substring(0,8))? The native controller will restart; existing database and R tunnel remain registered.",
                'Update Rakazo', [System.Windows.Forms.MessageBoxButtons]::YesNo,
                [System.Windows.Forms.MessageBoxIcon]::Warning
            )
            if ($response -ne [System.Windows.Forms.DialogResult]::Yes) { return }
            $started = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')
            $args = '-NoProfile -ExecutionPolicy Bypass -File "'+$Updater+'" -Action Apply -Repo "'+
                $Repo+'" -ExpectedTarget '+$plan.target+' -ControllerPid '+$PID+' -ControllerStarted "'+$started+'"'
            $child = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -PassThru
            if (-not $child -or $child.HasExited) { throw 'Updater process failed to start.' }
            $Context.ExitThread()
        } catch {
            [System.Windows.Forms.MessageBox]::Show('Update could not start. Check Rakazo status and the native update log.', 'Rakazo updates') | Out-Null
        } finally { $guard.Busy = $false }
    }.GetNewClosure())
    $refreshPath = Join-Path (Split-Path -Parent $Updater) 'Refresh-PluginR.ps1'
    $refresh = $Menu.Items.Add('Refresh Plugin R')
    $refresh.add_Click({
        if ($guard.Busy) { return }
        $guard.Busy = $true
        try {
            if (-not (Test-Path -LiteralPath $refreshPath -PathType Leaf)) { throw 'Refresh script missing.' }
            $choice = [System.Windows.Forms.MessageBox]::Show(
                'Briefly interrupt Plugin R in all chats and refresh only its existing registered process? Rakazo, its database and Windows Host remain running.',
                'Refresh Plugin R', [System.Windows.Forms.MessageBoxButtons]::YesNo,
                [System.Windows.Forms.MessageBoxIcon]::Warning
            )
            if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) { return }
            $args = '-NoProfile -ExecutionPolicy Bypass -File "'+$refreshPath+'"'
            $child = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -PassThru
            if (-not $child -or $child.HasExited) { throw 'Refresh process did not start.' }
        } catch {
            [System.Windows.Forms.MessageBox]::Show('Plugin R refresh could not start; inspect the local audit log.', 'Rakazo updates') | Out-Null
        } finally { $guard.Busy = $false }
    }.GetNewClosure())
}
