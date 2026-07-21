$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$root = (Get-Location).Path
$port = 8080
$serverScript = Join-Path $root "server.py"
$stdoutLog = Join-Path $root "server-tray.log"
$stderrLog = Join-Path $root "server-tray.err.log"
$debugLog = Join-Path $root "server-tray-debug.log"

function Write-TrayLog {
  param([string]$Message)
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $debugLog -Encoding UTF8 -Value "[$stamp] $Message"
}

function Resolve-PythonLaunch {
  $candidates = @()
  $localPython = Join-Path $env:LOCALAPPDATA "Python"
  if (Test-Path -LiteralPath $localPython) {
    $candidates += Get-ChildItem -LiteralPath $localPython -Filter python.exe -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -like "*pythoncore*" } |
      Sort-Object -Property FullName -Descending |
      ForEach-Object { $_.FullName }
    $candidates += Join-Path $localPython "bin\python.exe"
  }

  $pathPython = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($pathPython) {
    $candidates += $pathPython.Source
  }

  $pythonPath = $candidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) -and ($_ -notlike "*\WindowsApps\*") } |
    Select-Object -First 1

  if ($pythonPath) {
    return @{
      FilePath = $pythonPath
      Args = @("-u", $serverScript, "$port")
    }
  }

  $fallbackPython = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if ($fallbackPython) {
    return @{
      FilePath = $fallbackPython
      Args = @("-u", $serverScript, "$port")
    }
  }

  throw "Python was not found"
}

function Test-TenderBombHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Start-TenderBombServer {
  Write-TrayLog "Starting server"
  $launch = Resolve-PythonLaunch
  Write-TrayLog "Python: $($launch.FilePath)"
  Write-TrayLog "Args: $($launch.Args -join ' ')"

  $startArgs = @{
    FilePath               = $launch.FilePath
    ArgumentList           = $launch.Args
    WorkingDirectory       = $root
    WindowStyle            = "Hidden"
    RedirectStandardOutput = $stdoutLog
    RedirectStandardError  = $stderrLog
    PassThru               = $true
  }
  $process = Start-Process @startArgs

  Start-Sleep -Milliseconds 500
  if ($process.HasExited) {
    $tail = ""
    if (Test-Path -LiteralPath $stderrLog) {
      $tail = (Get-Content -LiteralPath $stderrLog -Tail 10) -join " "
    }
    throw "Server process exited immediately. $tail"
  }

  for ($attempt = 0; $attempt -lt 12; $attempt += 1) {
    if (Test-TenderBombHealth) {
      Write-TrayLog "Server is healthy, pid=$($process.Id)"
      return $process
    }
    Start-Sleep -Milliseconds 500
  }

  throw "Server did not answer /api/health"
}

function Stop-TenderBombServer {
  if ($script:serverProcess -and -not $script:serverProcess.HasExited) {
    Write-TrayLog "Stopping server pid=$($script:serverProcess.Id)"
    $script:serverProcess.Kill()
    $script:serverProcess.WaitForExit(3000) | Out-Null
  }
  $script:serverProcess = $null
  $listenerPids = netstat -ano | Select-String ":$port" | Where-Object { $_ -match 'LISTENING\s+(\d+)\s*$' } | ForEach-Object { [int]$Matches[1] } | Sort-Object -Unique
  foreach ($listenerPid in $listenerPids) {
    $process = Get-Process -Id $listenerPid -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -in @("python", "py")) {
      Write-TrayLog "Stopping listener pid=$listenerPid"
      Stop-Process -Id $listenerPid -Force
    }
  }
}

function Set-TrayStatus {
  param(
    [string]$Text,
    [System.Windows.Forms.ToolTipIcon]$Icon = [System.Windows.Forms.ToolTipIcon]::Info
  )
  $notify.Text = "TenderBomb server"
  $notify.ShowBalloonTip(3000, "TenderBomb server", $Text, $Icon)
}

function Restart-TenderBombServer {
  try {
    $script:isRestarting = $true
    if ($consoleItem) {
      $consoleItem.Enabled = $false
    }
    $restartItem.Enabled = $false
    Stop-TenderBombServer
    Start-Sleep -Milliseconds 700
    $script:serverProcess = Start-TenderBombServer
    Set-TrayStatus "Сервер запущен." ([System.Windows.Forms.ToolTipIcon]::Info)
  } catch {
    Write-TrayLog "Start failed: $($_.Exception.Message)"
    Set-TrayStatus "Сервер не запустился. Смотри server-tray-debug.log" ([System.Windows.Forms.ToolTipIcon]::Error)
  } finally {
    $script:isRestarting = $false
    if ($consoleItem) {
      $consoleItem.Enabled = $true
    }
    $restartItem.Enabled = $true
  }
}

function Open-TenderBombConsole {
  try {
    $script:isRestarting = $true
    $consoleItem.Enabled = $false
    $restartItem.Enabled = $false
    $timer.Stop()
    Write-TrayLog "Switching to console mode"
    Stop-TenderBombServer | Out-Null
    $bat = Join-Path $root "start-server.bat"
    Start-Process -FilePath $bat -WorkingDirectory $root
    $notify.Visible = $false
    $notify.Dispose()
    $appContext.ExitThread()
  } catch {
    Write-TrayLog "Open console failed: $($_.Exception.Message)"
    Set-TrayStatus "Не удалось открыть консоль. Смотри server-tray-debug.log" ([System.Windows.Forms.ToolTipIcon]::Error)
    $script:isRestarting = $false
    $consoleItem.Enabled = $true
    $restartItem.Enabled = $true
    $timer.Start()
  }
}

Write-TrayLog "Tray script started"

$script:serverProcess = $null
$script:isRestarting = $false

$appContext = New-Object System.Windows.Forms.ApplicationContext
$notify = New-Object System.Windows.Forms.NotifyIcon
$iconPath = Join-Path $root "assets\bomb.ico"
if (Test-Path -LiteralPath $iconPath) {
    $notify.Icon = New-Object System.Drawing.Icon($iconPath)
} else {
    Write-TrayLog "Icon not found at $iconPath, using default."
    $notify.Icon = [System.Drawing.SystemIcons]::Shield
}
$notify.Text = "TenderBomb server"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$consoleItem = $menu.Items.Add("Развернуть из трея")
$restartItem = $menu.Items.Add("Перезапуск")
$exitItem = $menu.Items.Add("Остановить сервер")
$notify.ContextMenuStrip = $menu

$consoleItem.Add_Click({
  Open-TenderBombConsole
})

$restartItem.Add_Click({
  Restart-TenderBombServer
})

$exitItem.Add_Click({
  $timer.Stop()
  Stop-TenderBombServer
  $notify.Visible = $false
  $notify.Dispose()
  $appContext.ExitThread()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({
  if (-not $script:isRestarting -and $script:serverProcess -and $script:serverProcess.HasExited) {
    Write-TrayLog "Server exited unexpectedly"
    $script:serverProcess = $null
    Set-TrayStatus "Сервер остановился. Можно нажать Рестарт." ([System.Windows.Forms.ToolTipIcon]::Warning)
  }
})
$timer.Start()

Restart-TenderBombServer
[System.Windows.Forms.Application]::Run($appContext)

Stop-TenderBombServer
Write-TrayLog "Tray script stopped"
