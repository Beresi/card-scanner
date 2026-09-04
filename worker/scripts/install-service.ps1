<#
.SYNOPSIS
    Install / manage the Card // Broker self-hosted backend as a background
    Windows Scheduled Task that starts at logon.

.DESCRIPTION
    This replaces the Cloudflare Worker + cron. Once installed, the API and the
    scan heartbeat run whenever the machine is on, whether or not the desktop
    app is open — matching the always-on behaviour the cloud deployment had.

    Design choices, and why:

    * Scheduled Task, not a Windows Service. A service would need elevation to
      install and a service wrapper (nssm/winsw) to host a Node process. A
      logon-triggered task needs neither and is trivially inspectable in
      taskschd.msc.

    * Launched through a .vbs shim. Running node.exe directly from a task shows
      a console window for the life of the process. WScript's Run with an
      intWindowStyle of 0 starts the batch file fully hidden, which is the
      standard no-elevation way to get a windowless background process.

    * Run via tsx straight from the repo rather than a compiled bundle. The
      server reads src/db/schema.sql and src/db/migrations/*.sql at boot, so
      running in place keeps schema and migrations automatically current — a
      new migration takes effect on the next restart with no rebuild step.

    * Absolute paths to node.exe and the tsx CLI. Scheduled Tasks do not inherit
      an interactive PATH, so `npx`/`node` by bare name is unreliable there.

.PARAMETER Port
    Port for the loopback API. Default 8787 (what the desktop client falls back
    to). Must match VITE_API_BASE_URL in desktop/.env.local.

.PARAMETER Uninstall
    Remove the scheduled task and the generated launcher files. Leaves the
    database and logs untouched.

.PARAMETER Status
    Print the task state, whether the port is listening, and the log tail.

.PARAMETER Stop
    Stop the running backend, leaving the task registered so it comes back at
    the next logon.

.PARAMETER Restart
    Stop then start the backend. Use this after changing server code.

.NOTES
    STOPPING IS BY PORT, NOT BY TASK. The .vbs shim returns as soon as it has
    spawned the backend, so the Scheduled Task reaches "Ready" within a second
    while the node process keeps running, orphaned from the task. `schtasks /end`
    therefore terminates nothing. Every stop path here finds the process actually
    listening on the port and kills that.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -Status
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -Uninstall
#>

[CmdletBinding()]
param(
    [int]    $Port = 8787,
    [switch] $Uninstall,
    [switch] $Status,
    [switch] $Stop,
    [switch] $Restart
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

$TaskName   = 'CardBrokerBackend'
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkerDir  = Split-Path -Parent $ScriptDir
$DataDir    = Join-Path $env:APPDATA 'CardBroker'
$LogDir     = Join-Path $DataDir 'logs'
$LogFile    = Join-Path $LogDir  'backend.log'
$CmdFile    = Join-Path $DataDir 'start-backend.cmd'
$VbsFile    = Join-Path $DataDir 'start-backend.vbs'
$ServerTs   = Join-Path $WorkerDir 'scripts\server-local.ts'
$TsxCli     = Join-Path $WorkerDir 'node_modules\tsx\dist\cli.mjs'

function Write-Step  ([string] $m) { Write-Host "  $m" }
function Write-Title ([string] $m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }

# ---------------------------------------------------------------------------
# Process control
#
# The backend is stopped by port, never by `schtasks /end` — see the NOTES block
# above for why the task is already "Ready" while the server is still running.
# ---------------------------------------------------------------------------

function Get-BackendPid {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if ($null -eq $conn) { return $null }
    return $conn[0].OwningProcess
}

function Stop-Backend {
    $procId = Get-BackendPid
    if ($null -eq $procId) {
        Write-Step "Nothing was listening on port $Port"
        return
    }
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    # Wait for the port to actually free so a restart cannot race the bind.
    foreach ($i in 1..20) {
        Start-Sleep -Milliseconds 250
        if ($null -eq (Get-BackendPid)) { break }
    }
    Write-Step "Stopped the backend (pid $procId)"
}

function Start-Backend {
    Start-ScheduledTask -TaskName $TaskName
    foreach ($i in 1..30) {
        Start-Sleep -Milliseconds 500
        if ($null -ne (Get-BackendPid)) { return $true }
    }
    return $false
}

# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

if ($Stop -or $Restart) {
    $verb = 'Stopping'
    if ($Restart) { $verb = 'Restarting' }
    Write-Title "$verb the Card // Broker backend"
    Stop-Backend

    if ($Restart) {
        if (Start-Backend) {
            Write-Step "Backend is listening on http://127.0.0.1:$Port"
        } else {
            Write-Step "Backend did not come back up — check $LogFile"
        }
    }
    Write-Host ''
    return
}

if ($Status) {
    Write-Title 'Card // Broker backend — status'

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        Write-Step 'Scheduled task : NOT INSTALLED'
    } else {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Step "Scheduled task : $($task.State)"
        Write-Step "Last run       : $($info.LastRunTime)  (result $($info.LastTaskResult))"
    }

    $listening = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if ($null -eq $listening) {
        Write-Step "Port $Port      : not listening"
    } else {
        Write-Step "Port $Port      : LISTENING (pid $($listening[0].OwningProcess))"
    }

    if (Test-Path $LogFile) {
        Write-Step "Log            : $LogFile"
        Write-Host ''
        Get-Content $LogFile -Tail 15 | ForEach-Object { Write-Host "    $_" }
    } else {
        Write-Step "Log            : (none yet)"
    }
    Write-Host ''
    return
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

if ($Uninstall) {
    Write-Title 'Removing the Card // Broker backend task'

    # Kill the running server FIRST — unregistering the task does not stop it.
    Stop-Backend

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $task) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Step "Unregistered task '$TaskName'"
    } else {
        Write-Step "Task '$TaskName' was not installed"
    }

    foreach ($f in @($CmdFile, $VbsFile)) {
        if (Test-Path $f) { Remove-Item $f -Force; Write-Step "Removed $f" }
    }

    Write-Step 'Database and logs were left in place.'
    Write-Host ''
    return
}

# ---------------------------------------------------------------------------
# Install — preflight
# ---------------------------------------------------------------------------

Write-Title 'Installing the Card // Broker self-hosted backend'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    throw "node.exe not found on PATH. Install Node.js 20+ (or run this from a shell where 'node' resolves) and retry."
}

if (-not (Test-Path $TsxCli)) {
    throw "tsx not found at $TsxCli. Run 'npm install' in $WorkerDir first."
}
if (-not (Test-Path $ServerTs)) {
    throw "server entry not found at $ServerTs."
}

# Credentials must resolve before the task is installed, otherwise the task
# would silently fail at every logon. The server reads .dev.vars.local then
# .dev.vars; check the same pair here without ever reading a value out.
$haveCt = $false
$haveAuth = $false
foreach ($vf in @((Join-Path $WorkerDir '.dev.vars.local'), (Join-Path $WorkerDir '.dev.vars'))) {
    if (Test-Path $vf) {
        foreach ($line in Get-Content $vf) {
            if ($line -match '^\s*CARDTRADER_API_TOKEN\s*=\s*\S') { $haveCt = $true }
            if ($line -match '^\s*DESKTOP_AUTH_TOKEN\s*=\s*\S')   { $haveAuth = $true }
        }
    }
}
if (-not $haveCt)   { throw "CARDTRADER_API_TOKEN is not set in $WorkerDir\.dev.vars(.local)." }
if (-not $haveAuth) { throw "DESKTOP_AUTH_TOKEN is not set in $WorkerDir\.dev.vars(.local)." }

Write-Step "node    : $node"
Write-Step "worker  : $WorkerDir"
Write-Step "data    : $DataDir"
Write-Step "port    : $Port"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

# ---------------------------------------------------------------------------
# Launcher files
# ---------------------------------------------------------------------------

# Batch wrapper: owns the working directory, the port, and the log redirect.
# Batch handles the nested quoting of these paths far more predictably than
# doing the same redirect inside the VBScript Run string.
$cmdBody = @"
@echo off
rem Generated by scripts\install-service.ps1 — regenerate rather than hand-editing.
set "CARD_BROKER_PORT=$Port"
cd /d "$WorkerDir"
echo. >> "$LogFile"
echo ==== started %DATE% %TIME% ==== >> "$LogFile"
"$node" "$TsxCli" "$ServerTs" >> "$LogFile" 2>&1
echo ==== exited %DATE% %TIME% with errorlevel %ERRORLEVEL% ==== >> "$LogFile"
"@
Set-Content -Path $CmdFile -Value $cmdBody -Encoding ASCII
Write-Step "Wrote $CmdFile"

# VBScript shim: window style 0 = hidden, bWaitOnReturn = False.
# This is what keeps a console window from appearing at every logon.
$vbsBody = @"
' Generated by scripts\install-service.ps1 — launches the backend with no window.
CreateObject("WScript.Shell").Run """$CmdFile""", 0, False
"@
Set-Content -Path $VbsFile -Value $vbsBody -Encoding ASCII
Write-Step "Wrote $VbsFile"

# ---------------------------------------------------------------------------
# Scheduled task
# ---------------------------------------------------------------------------

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    # Stop the running server before re-registering, or the freshly started
    # instance races the old one for the port and loses.
    Stop-Backend
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Step 'Removed the previous task registration'
}

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument """$VbsFile""" -WorkingDirectory $WorkerDir

# At logon of THIS user. The task therefore inherits the user profile, which is
# what makes %APPDATA% (the database location) resolve identically to a manual run.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Interactive principal at the default (non-elevated) run level: no admin rights
# needed to register, and none needed to run.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $action `
    -Trigger     $trigger `
    -Principal   $principal `
    -Settings    $settings `
    -Description 'Card // Broker self-hosted backend — local API + hourly scan heartbeat (replaces the Cloudflare Worker).' | Out-Null

Write-Step "Registered scheduled task '$TaskName' (at logon)"

# ---------------------------------------------------------------------------
# Start now + verify
# ---------------------------------------------------------------------------

$ok = Start-Backend
Write-Step 'Started the task'

Write-Host ''
if ($ok) {
    Write-Host "  Backend is listening on http://127.0.0.1:$Port" -ForegroundColor Green
    Write-Host "  Log: $LogFile"
    Write-Host ''
    Write-Host '  It will start automatically at every logon.'
    Write-Host "  Check on it any time with:  install-service.ps1 -Status"
} else {
    Write-Host "  Task registered, but nothing is listening on port $Port yet." -ForegroundColor Yellow
    Write-Host "  Check the log for the reason: $LogFile"
    if (Test-Path $LogFile) { Get-Content $LogFile -Tail 20 | ForEach-Object { Write-Host "    $_" } }
}
Write-Host ''
