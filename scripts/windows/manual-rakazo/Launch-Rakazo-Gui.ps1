# Console-free startup status window for the native Rakazo controller.
# Compatible with Windows PowerShell 5.1. Shows fixed launcher stages and local errors only.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$controllerScript = Join-Path $PSScriptRoot 'Rakazo.ps1'
$stateDir = Join-Path $env:LOCALAPPDATA 'Rakazo\manual-launcher'
$stageLog = Join-Path $stateDir 'launcher-stage.log'
$controllerStdout = Join-Path $stateDir 'gui-controller.stdout.log'
$controllerStderr = Join-Path $stateDir 'gui-controller.stderr.log'
$guiDiagnostic = Join-Path $stateDir 'gui-startup.log'

function Write-GuiDiagnostic {
    param([string]$Message)
    try {
        if (-not (Test-Path -LiteralPath $stateDir -PathType Container)) {
            New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
        }
        Add-Content -LiteralPath $guiDiagnostic -Encoding UTF8 -Value (
            '{0:u} {1}' -f [DateTime]::UtcNow, $Message
        )
    } catch { }
}

function Get-TailText {
    param([string]$Path, [int]$Lines = 30)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    try { return ((Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction Stop) -join [Environment]::NewLine) }
    catch { return '' }
}

function Get-RelevantErrorText {
    param([string]$Stage)
    $parts = @()
    $controllerError = Get-TailText -Path $controllerStderr -Lines 35
    if ($controllerError) {
        $parts += 'Controller error:'
        $parts += $controllerError
    }

    $role = $null
    if ($Stage -match '(?i)api') { $role = 'api' }
    elseif ($Stage -match '(?i)worker') { $role = 'worker' }
    elseif ($Stage -match '(?i)web') { $role = 'web' }
    elseif ($Stage -match '(?i)host') { $role = 'host' }

    if ($role) {
        $roleError = Get-TailText -Path (Join-Path $stateDir ($role + '.stderr.log')) -Lines 35
        if ($roleError) {
            $parts += ''
            $parts += ($role.ToUpperInvariant() + ' error:')
            $parts += $roleError
        }
    }
    elseif ($Stage -match '(?i)postgres') {
        $postgresError = Get-TailText -Path (Join-Path $HOME 'RakazoData\postgres17.log') -Lines 35
        if ($postgresError) {
            [void]$parts.Add('')
            $parts += 'PostgreSQL log:'
            $parts += $postgresError
        }
    }

    return ($parts -join [Environment]::NewLine)
}

function Get-StageLabel {
    param([string]$Stage)
    switch -Regex ($Stage) {
        '^controller acquired$' { return 'Проверка запуска...' }
        '^existing R verified' { return 'Проверка Plugin R...' }
        '^native postgres check/start$' { return 'Запуск PostgreSQL...' }
        '^stale postgres pidfile' { return 'Восстановление PostgreSQL...' }
        '^pg_ctl returned' { return 'Проверка PostgreSQL...' }
        '^native postgres ready$' { return 'PostgreSQL готов' }
        '^api child started' { return 'Запуск API...' }
        '^api ready$' { return 'API готов' }
        '^worker child started$' { return 'Запуск Worker...' }
        '^web child started' { return 'Запуск Web...' }
        '^web ready$' { return 'Web готов' }
        '^host child started$' { return 'Запуск Windows Host...' }
        '^connecting existing registered R$' { return 'Подключение Plugin R...' }
        '^existing R connected' { return 'Plugin R подключён' }
        '^existing R reused' { return 'Plugin R готов' }
        '^tray active$' { return 'Rakazo готов' }
        '^FAILED at ' { return ('Ошибка запуска: ' + ($Stage -replace '^FAILED at\s*', '')) }
        default { return $Stage }
    }
}

Write-GuiDiagnostic 'startup GUI process entered'

try {
    if (-not (Test-Path -LiteralPath $controllerScript -PathType Leaf)) {
        throw 'Rakazo.ps1 was not found beside the GUI launcher.'
    }
    if (-not (Test-Path -LiteralPath $stateDir -PathType Container)) {
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    }

    Write-GuiDiagnostic 'loading WinForms'
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()

    $baselineLines = 0
    if (Test-Path -LiteralPath $stageLog -PathType Leaf) {
        $baselineLines = @(Get-Content -LiteralPath $stageLog -ErrorAction SilentlyContinue).Count
    }
    Remove-Item -LiteralPath $controllerStdout -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $controllerStderr -Force -ErrorAction SilentlyContinue

    Write-GuiDiagnostic 'building startup window'
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Rakazo'
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $form.MaximizeBox = $false
    $form.MinimizeBox = $true
    $form.ClientSize = New-Object System.Drawing.Size -ArgumentList 660,380
    $form.TopMost = $true

    $title = New-Object System.Windows.Forms.Label
    $title.Text = 'Запуск Rakazo'
    $title.AutoSize = $true
    $title.Location = New-Object System.Drawing.Point -ArgumentList 20,18
    $form.Controls.Add($title)

    $status = New-Object System.Windows.Forms.Label
    $status.Text = 'Подготовка...'
    $status.AutoSize = $false
    $status.Size = New-Object System.Drawing.Size -ArgumentList 615,28
    $status.Location = New-Object System.Drawing.Point -ArgumentList 22,58
    $form.Controls.Add($status)

    $progress = New-Object System.Windows.Forms.ProgressBar
    $progress.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
    $progress.MarqueeAnimationSpeed = 25
    $progress.Size = New-Object System.Drawing.Size -ArgumentList 615,16
    $progress.Location = New-Object System.Drawing.Point -ArgumentList 22,92
    $form.Controls.Add($progress)

    $details = New-Object System.Windows.Forms.TextBox
    $details.Multiline = $true
    $details.ReadOnly = $true
    $details.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
    $details.WordWrap = $false
    $details.Size = New-Object System.Drawing.Size -ArgumentList 615,205
    $details.Location = New-Object System.Drawing.Point -ArgumentList 22,122
    $form.Controls.Add($details)

    $openLogs = New-Object System.Windows.Forms.Button
    $openLogs.Text = 'Открыть журнал'
    $openLogs.Size = New-Object System.Drawing.Size -ArgumentList 125,30
    $openLogs.Location = New-Object System.Drawing.Point -ArgumentList 22,340
    $openLogs.Add_Click({
        try { Start-Process explorer.exe -ArgumentList ('"' + $stateDir + '"') } catch { }
    })
    $form.Controls.Add($openLogs)

    $close = New-Object System.Windows.Forms.Button
    $close.Text = 'Закрыть'
    $close.Size = New-Object System.Drawing.Size -ArgumentList 100,30
    $close.Location = New-Object System.Drawing.Point -ArgumentList 537,340
    $close.Visible = $false
    $close.Add_Click({
        $script:allowClose = $true
        $form.Close()
    })
    $form.Controls.Add($close)

    function Append-Detail {
        param([string]$Text)
        if ([string]::IsNullOrWhiteSpace($Text)) { return }
        if ($details.TextLength -gt 0) { $details.AppendText([Environment]::NewLine) }
        $details.AppendText($Text)
        $details.SelectionStart = $details.TextLength
        $details.ScrollToCaret()
    }

    $script:controller = $null
    $script:allowClose = $false
    $script:ready = $false
    $script:failureShown = $false
    $script:lastStage = ''
    $script:stageLineOffset = $baselineLines
    $script:closeAt = $null
    $script:guiExitCode = 0

    $form.Add_FormClosing({
        param($sender, $eventArgs)
        if ($script:allowClose) { return }
        if ($null -ne $script:controller) {
            try {
                $script:controller.Refresh()
                if (-not $script:controller.HasExited -and -not $script:ready) {
                    $eventArgs.Cancel = $true
                    [System.Windows.Forms.MessageBox]::Show(
                        'Rakazo ещё запускается. Окно закроется автоматически после успешного запуска.',
                        'Rakazo',
                        [System.Windows.Forms.MessageBoxButtons]::OK,
                        [System.Windows.Forms.MessageBoxIcon]::Information
                    ) | Out-Null
                }
            } catch { }
        }
    })

    Write-GuiDiagnostic 'starting native controller'
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoLogo -NoProfile -NonInteractive -Sta -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
        $controllerScript + '" -Action Run'
    $startArgs = @{
        FilePath = $powershell
        ArgumentList = $arguments
        WorkingDirectory = $repo
        WindowStyle = 'Hidden'
        RedirectStandardOutput = $controllerStdout
        RedirectStandardError = $controllerStderr
        PassThru = $true
    }
    $script:controller = Start-Process @startArgs
    Write-GuiDiagnostic ('controller process started pid=' + $script:controller.Id)

    Append-Detail 'Контроллер запущен. Ожидание этапов...'

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 300
    $timer.Add_Tick({
        try {
            if (Test-Path -LiteralPath $stageLog -PathType Leaf) {
                $all = @(Get-Content -LiteralPath $stageLog -ErrorAction SilentlyContinue)
                if ($all.Count -gt $script:stageLineOffset) {
                    $newLines = @($all | Select-Object -Skip $script:stageLineOffset)
                    $script:stageLineOffset = $all.Count
                    foreach ($line in $newLines) {
                        $stage = $line -replace '^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}Z\s+', ''
                        if ([string]::IsNullOrWhiteSpace($stage)) { continue }
                        $script:lastStage = $stage
                        Append-Detail $stage
                        $status.Text = Get-StageLabel -Stage $stage
                        if ($stage -ceq 'tray active') {
                            $script:ready = $true
                            $progress.Style = [System.Windows.Forms.ProgressBarStyle]::Blocks
                            $progress.Value = 100
                            $status.Text = 'Rakazo готов'
                            Write-GuiDiagnostic 'tray active observed; startup window will close'
                            $script:closeAt = [DateTime]::UtcNow.AddMilliseconds(900)
                        }
                    }
                }
            }

            if ($null -ne $script:closeAt -and [DateTime]::UtcNow -ge $script:closeAt) {
                $script:allowClose = $true
                $timer.Stop()
                $form.Close()
                return
            }

            if ($null -ne $script:controller -and -not $script:ready) {
                $script:controller.Refresh()
                if ($script:controller.HasExited -and -not $script:failureShown) {
                    if ($script:controller.ExitCode -eq 0) {
                        $status.Text = 'Rakazo уже запущен или Web уже открыт'
                        Append-Detail 'Контроллер завершился без ошибки до создания нового tray.'
                        $progress.Style = [System.Windows.Forms.ProgressBarStyle]::Blocks
                        $progress.Value = 100
                        Write-GuiDiagnostic 'controller exited 0 before tray active'
                        $script:closeAt = [DateTime]::UtcNow.AddMilliseconds(1200)
                    } else {
                        $script:failureShown = $true
                        $script:guiExitCode = 1
                        $progress.Style = [System.Windows.Forms.ProgressBarStyle]::Blocks
                        $progress.Value = 0
                        if ($script:lastStage) {
                            $status.Text = 'Не удалось запустить Rakazo - ' + (Get-StageLabel -Stage $script:lastStage)
                        } else {
                            $status.Text = 'Не удалось запустить Rakazo'
                        }
                        $errorText = Get-RelevantErrorText -Stage $script:lastStage
                        if ($errorText) {
                            Append-Detail ''
                            Append-Detail $errorText
                        }
                        Write-GuiDiagnostic ('controller exited with code ' + $script:controller.ExitCode)
                        $close.Visible = $true
                        $form.TopMost = $false
                    }
                }
            }
        } catch {
            $script:failureShown = $true
            $script:guiExitCode = 1
            $status.Text = 'Ошибка окна запуска Rakazo'
            Append-Detail $_.Exception.Message
            Write-GuiDiagnostic ('timer failure: ' + $_.Exception.ToString())
            $close.Visible = $true
            $form.TopMost = $false
        }
    })
    $timer.Start()

    Write-GuiDiagnostic 'showing startup window'
    [System.Windows.Forms.Application]::Run($form)
    Write-GuiDiagnostic 'startup window closed'
    $timer.Stop()
    $timer.Dispose()
    $form.Dispose()
    exit $script:guiExitCode
}
catch {
    Write-GuiDiagnostic ('FATAL: ' + $_.Exception.ToString())
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
        [System.Windows.Forms.MessageBox]::Show(
            ('Не удалось открыть окно запуска Rakazo.' + [Environment]::NewLine + [Environment]::NewLine +
             $_.Exception.Message + [Environment]::NewLine + [Environment]::NewLine +
             'Диагностика: ' + $guiDiagnostic),
            'Rakazo',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    } catch { }
    exit 1
}
