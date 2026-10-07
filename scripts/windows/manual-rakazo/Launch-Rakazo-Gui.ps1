# Console-free startup status window for the native Rakazo controller.
# Shows only fixed launcher stages and local error logs; never prints .env or tunnel secrets.
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
$iconPath = Join-Path $repo 'apps\desktop\assets\icon.ico'

function Get-TailText {
    param([string]$Path, [int]$Lines = 30)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    try { return ((Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction Stop) -join [Environment]::NewLine) }
    catch { return '' }
}

function Get-RelevantErrorText {
    param([string]$Stage)
    $parts = [System.Collections.Generic.List[string]]::new()
    $controllerError = Get-TailText -Path $controllerStderr -Lines 35
    if ($controllerError) {
        $parts.Add('Controller error:')
        $parts.Add($controllerError)
    }

    $role = $null
    if ($Stage -match '(?i)api') { $role = 'api' }
    elseif ($Stage -match '(?i)worker') { $role = 'worker' }
    elseif ($Stage -match '(?i)web') { $role = 'web' }
    elseif ($Stage -match '(?i)host') { $role = 'host' }

    if ($role) {
        $roleError = Get-TailText -Path (Join-Path $stateDir ($role + '.stderr.log')) -Lines 35
        if ($roleError) {
            $parts.Add('')
            $parts.Add(($role.ToUpperInvariant() + ' error:'))
            $parts.Add($roleError)
        }
    }
    elseif ($Stage -match '(?i)postgres') {
        $postgresError = Get-TailText -Path (Join-Path $HOME 'RakazoData\postgres17.log') -Lines 35
        if ($postgresError) {
            $parts.Add('')
            $parts.Add('PostgreSQL log:')
            $parts.Add($postgresError)
        }
    }

    return ($parts -join [Environment]::NewLine)
}

function Get-StageLabel {
    param([string]$Stage)
    switch -Regex ($Stage) {
        '^controller acquired$' { return 'Проверка запуска…' }
        '^existing R verified' { return 'Проверка Plugin R…' }
        '^native postgres check/start$' { return 'Запуск PostgreSQL…' }
        '^stale postgres pidfile' { return 'Восстановление PostgreSQL…' }
        '^pg_ctl returned' { return 'Проверка PostgreSQL…' }
        '^native postgres ready$' { return 'PostgreSQL готов' }
        '^api child started' { return 'Запуск API…' }
        '^api ready$' { return 'API готов' }
        '^worker child started$' { return 'Запуск Worker…' }
        '^web child started' { return 'Запуск Web…' }
        '^web ready$' { return 'Web готов' }
        '^host child started$' { return 'Запуск Windows Host…' }
        '^connecting existing registered R$' { return 'Подключение Plugin R…' }
        '^existing R connected' { return 'Plugin R подключён' }
        '^existing R reused' { return 'Plugin R готов' }
        '^tray active$' { return 'Rakazo готов' }
        '^FAILED at ' { return ('Ошибка запуска: ' + ($Stage -replace '^FAILED at\s*', '')) }
        default { return $Stage }
    }
}

try {
    if (-not (Test-Path -LiteralPath $controllerScript -PathType Leaf)) {
        throw 'Rakazo.ps1 was not found beside the GUI launcher.'
    }
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()

    $baselineLines = 0
    if (Test-Path -LiteralPath $stageLog -PathType Leaf) {
        $baselineLines = @(Get-Content -LiteralPath $stageLog -ErrorAction SilentlyContinue).Count
    }
    Remove-Item -LiteralPath $controllerStdout,$controllerStderr -Force -ErrorAction SilentlyContinue

    $form = [System.Windows.Forms.Form]::new()
    $form.Text = 'Rakazo'
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $true
    $form.ClientSize = [System.Drawing.Size]::new(660, 380)
    $form.TopMost = $true
    if (Test-Path -LiteralPath $iconPath -PathType Leaf) {
        $form.Icon = [System.Drawing.Icon]::new($iconPath)
    }

    $title = [System.Windows.Forms.Label]::new()
    $title.Text = 'Запуск Rakazo'
    $title.AutoSize = $true
    $title.Font = [System.Drawing.Font]::new('Segoe UI', 15, [System.Drawing.FontStyle]::Bold)
    $title.Location = [System.Drawing.Point]::new(20, 18)
    $form.Controls.Add($title)

    $status = [System.Windows.Forms.Label]::new()
    $status.Text = 'Подготовка…'
    $status.AutoSize = $false
    $status.Size = [System.Drawing.Size]::new(615, 28)
    $status.Location = [System.Drawing.Point]::new(22, 58)
    $status.Font = [System.Drawing.Font]::new('Segoe UI', 10)
    $form.Controls.Add($status)

    $progress = [System.Windows.Forms.ProgressBar]::new()
    $progress.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
    $progress.MarqueeAnimationSpeed = 25
    $progress.Size = [System.Drawing.Size]::new(615, 16)
    $progress.Location = [System.Drawing.Point]::new(22, 92)
    $form.Controls.Add($progress)

    $details = [System.Windows.Forms.TextBox]::new()
    $details.Multiline = $true
    $details.ReadOnly = $true
    $details.ScrollBars = 'Vertical'
    $details.WordWrap = $false
    $details.Size = [System.Drawing.Size]::new(615, 205)
    $details.Location = [System.Drawing.Point]::new(22, 122)
    $details.Font = [System.Drawing.Font]::new('Consolas', 9)
    $form.Controls.Add($details)

    $openLogs = [System.Windows.Forms.Button]::new()
    $openLogs.Text = 'Открыть журнал'
    $openLogs.Size = [System.Drawing.Size]::new(125, 30)
    $openLogs.Location = [System.Drawing.Point]::new(22, 340)
    $openLogs.add_Click({ Start-Process explorer.exe -ArgumentList ('"' + $stateDir + '"') })
    $form.Controls.Add($openLogs)

    $close = [System.Windows.Forms.Button]::new()
    $close.Text = 'Закрыть'
    $close.Size = [System.Drawing.Size]::new(100, 30)
    $close.Location = [System.Drawing.Point]::new(537, 340)
    $close.Visible = $false
    $close.add_Click({
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

    $form.add_FormClosing({
        param($sender, $e)
        if ($script:allowClose) { return }
        if ($null -ne $script:controller) {
            try {
                $script:controller.Refresh()
                if (-not $script:controller.HasExited -and -not $script:ready) {
                    $e.Cancel = $true
                    [System.Windows.Forms.MessageBox]::Show(
                        'Rakazo ещё запускается. Это окно закроется автоматически после успешного запуска.',
                        'Rakazo',
                        [System.Windows.Forms.MessageBoxButtons]::OK,
                        [System.Windows.Forms.MessageBoxIcon]::Information
                    ) | Out-Null
                }
            } catch { }
        }
    })

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

    Append-Detail 'Контроллер запущен. Ожидание этапов…'

    $timer = [System.Windows.Forms.Timer]::new()
    $timer.Interval = 300
    $timer.add_Tick({
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
                        Append-Detail 'Контроллер завершился без ошибки до создания нового tray. Повторный экземпляр не требуется.'
                        $progress.Style = [System.Windows.Forms.ProgressBarStyle]::Blocks
                        $progress.Value = 100
                        $script:closeAt = [DateTime]::UtcNow.AddMilliseconds(1200)
                    } else {
                        $script:failureShown = $true
                        $script:guiExitCode = 1
                        $progress.Style = [System.Windows.Forms.ProgressBarStyle]::Blocks
                        $progress.Value = 0
                        $status.Text = if ($script:lastStage) {
                            'Не удалось запустить Rakazo — ' + (Get-StageLabel -Stage $script:lastStage)
                        } else {
                            'Не удалось запустить Rakazo'
                        }
                        $errorText = Get-RelevantErrorText -Stage $script:lastStage
                        if ($errorText) {
                            Append-Detail ''
                            Append-Detail $errorText
                        }
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
            $close.Visible = $true
            $form.TopMost = $false
        }
    })
    $timer.Start()

    [System.Windows.Forms.Application]::Run($form)
    $timer.Stop()
    $timer.Dispose()
    $form.Dispose()
    exit $script:guiExitCode
}
catch {
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
        [System.Windows.Forms.MessageBox]::Show(
            ('Не удалось открыть окно запуска Rakazo.' + [Environment]::NewLine + [Environment]::NewLine + $_.Exception.Message),
            'Rakazo',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    } catch { }
    exit 1
}
