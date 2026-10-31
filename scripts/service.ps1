[CmdletBinding()]
param([ValidateSet('Install','Start','Stop','Restart','Status')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
$whiteboardRoot = Split-Path $PSScriptRoot -Parent
$whiteboardServiceName = 'HashiWhiteboard'
$whiteboardLegacyTaskName = 'HASHI Whiteboard'
$whiteboardServiceDir = Join-Path $whiteboardRoot 'data\service'
$whiteboardNssm = Join-Path $whiteboardServiceDir 'nssm.exe'
$whiteboardNode = (Get-Command node.exe).Source
$whiteboardEntry = Join-Path $whiteboardRoot 'server\host.mjs'
$whiteboardService = Get-Service -Name $whiteboardServiceName -ErrorAction SilentlyContinue
function Invoke-WhiteboardNssm {
  param([string[]]$Values)
  & $whiteboardNssm @Values | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ('NSSM operation failed: ' + ($Values -join ' ')) }
}
function Wait-WhiteboardOnline {
  $whiteboardSettings = Get-Content -Raw -LiteralPath (Join-Path $whiteboardRoot 'data\settings.json') | ConvertFrom-Json
  $whiteboardHost = $whiteboardSettings.host
  if ($whiteboardHost -eq '0.0.0.0') { $whiteboardHost = '127.0.0.1' }
  $whiteboardUrl = 'http://{0}:{1}' -f $whiteboardHost,$whiteboardSettings.port
  $whiteboardDeadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $whiteboardDeadline) {
    try {
      $whiteboardHealth = Invoke-RestMethod -Uri "$whiteboardUrl/api/health" -TimeoutSec 2
      if ($whiteboardHealth.ok -and $whiteboardHealth.product -eq 'HASHI Whiteboard') {
        $whiteboardHostStatus = Get-Content -Raw -LiteralPath (Join-Path $whiteboardRoot 'data\host-status.json') | ConvertFrom-Json
        $whiteboardBound = @(Get-NetTCPConnection -LocalPort $whiteboardSettings.port -State Listen -ErrorAction SilentlyContinue)
        $whiteboardHostProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($whiteboardHostStatus.host_pid)"
        $whiteboardNativeService = Get-CimInstance Win32_Service -Filter "Name = '$whiteboardServiceName'"
        if (($whiteboardBound.OwningProcess -contains $whiteboardHostStatus.worker_pid) -and $whiteboardHostProcess.ParentProcessId -eq $whiteboardNativeService.ProcessId -and $whiteboardNativeService.State -eq 'Running') { return $whiteboardUrl }
      }
    } catch {}
    Start-Sleep -Milliseconds 250
  }
  throw 'The native Whiteboard service did not become healthy. Check data\logs.'
}
function Stop-WhiteboardService {
  $whiteboardCurrent = Get-Service -Name $whiteboardServiceName
  if ($whiteboardCurrent.Status -ne 'Stopped') {
    Stop-Service -Name $whiteboardServiceName
    $whiteboardCurrent.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))
  }
}
if ($Action -eq 'Install') {
  if (!(Test-Path -LiteralPath (Join-Path $whiteboardRoot 'dist\index.html'))) { throw 'Run npm run build before installing the service.' }
  if (!(Test-Path -LiteralPath (Join-Path $whiteboardRoot 'data\settings.json'))) { throw 'Create data\settings.json before installing the service.' }
  $whiteboardLegacyTask = Get-ScheduledTask -TaskName $whiteboardLegacyTaskName -ErrorAction SilentlyContinue
  if ($whiteboardLegacyTask -and $whiteboardLegacyTask.Actions.Arguments -notcontains ('"' + $whiteboardEntry + '"')) { throw 'An unrelated task has the legacy name; it was not changed.' }
  New-Item -ItemType Directory -Path $whiteboardServiceDir -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $whiteboardRoot 'data\logs') -Force | Out-Null
  if (!(Test-Path -LiteralPath $whiteboardNssm)) {
    $whiteboardInstalledNssm = Get-Command nssm.exe -ErrorAction Stop
    [IO.File]::WriteAllBytes($whiteboardNssm, [IO.File]::ReadAllBytes($whiteboardInstalledNssm.Source))
    if ((Get-FileHash -LiteralPath $whiteboardNssm -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $whiteboardInstalledNssm.Source -Algorithm SHA256).Hash) { throw 'The pinned NSSM executable does not match the installed copy.' }
  }
  if ($whiteboardService) {
    $whiteboardExisting = Get-CimInstance Win32_Service -Filter "Name = '$whiteboardServiceName'"
    if ($whiteboardExisting.PathName.Trim('"') -ine $whiteboardNssm) { throw 'An unrelated service has this name; it was not changed.' }
  } else {
    Invoke-WhiteboardNssm -Values @('install', $whiteboardServiceName, $whiteboardNode)
  }
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'DisplayName', 'HASHI Whiteboard')
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'Description', 'Shared LAN whiteboard. Independent Windows service with automatic recovery.')
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'Application', $whiteboardNode)
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'AppParameters', ('"' + $whiteboardEntry + '"'))
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'AppDirectory', $whiteboardRoot)
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'Start', 'SERVICE_AUTO_START')
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'DependOnService', 'Tcpip')
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'AppExit', 'Default', 'Restart')
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'AppRestartDelay', '2000')
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'AppKillProcessTree', '1')
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'AppStopMethodSkip', '6')
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'AppStopMethodConsole', '5000')
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'AppStdout', (Join-Path $whiteboardRoot 'data\logs\host.stdout.log'))
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'AppStderr', (Join-Path $whiteboardRoot 'data\logs\host.stderr.log'))
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'AppRotateFiles', '1')
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'AppRotateOnline', '1')
  Invoke-WhiteboardNssm -Values @('set', $whiteboardServiceName, 'AppRotateBytes', '5242880')
  & sc.exe failure $whiteboardServiceName 'reset=' '86400' 'actions=' 'restart/2000/restart/5000/restart/10000' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Windows rejected service failure recovery configuration.' }
  & sc.exe failureflag $whiteboardServiceName '1' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Windows rejected service failure actions.' }
  $whiteboardLegacyWasRunning = $whiteboardLegacyTask -and $whiteboardLegacyTask.State -eq 'Running'
  try {
    if ($whiteboardLegacyTask) {
      [IO.File]::WriteAllText((Join-Path $whiteboardServiceDir 'legacy-task.xml'), (Export-ScheduledTask -TaskName $whiteboardLegacyTaskName), [Text.UTF8Encoding]::new($false))
      Disable-ScheduledTask -TaskName $whiteboardLegacyTaskName | Out-Null
      if ($whiteboardLegacyWasRunning) {
        Stop-ScheduledTask -TaskName $whiteboardLegacyTaskName
        $whiteboardStopDeadline = [DateTime]::UtcNow.AddSeconds(10)
        while ((Get-ScheduledTask -TaskName $whiteboardLegacyTaskName).State -eq 'Running' -and [DateTime]::UtcNow -lt $whiteboardStopDeadline) { Start-Sleep -Milliseconds 250 }
        if ((Get-ScheduledTask -TaskName $whiteboardLegacyTaskName).State -eq 'Running') { throw 'The legacy host did not stop.' }
      }
    }
    if ((Get-Service -Name $whiteboardServiceName).Status -ne 'Running') { Start-Service -Name $whiteboardServiceName }
    $whiteboardUrl = Wait-WhiteboardOnline
    if ($whiteboardLegacyTask) { Unregister-ScheduledTask -TaskName $whiteboardLegacyTaskName -Confirm:$false }
    [pscustomobject]@{ installed = $true; service = $whiteboardServiceName; state = 'Running'; start_type = 'Automatic'; url = $whiteboardUrl; legacy_task_removed = [bool]$whiteboardLegacyTask } | ConvertTo-Json -Compress
  } catch {
    $whiteboardMigrationFailure = $_
    Stop-WhiteboardService
    Set-Service -Name $whiteboardServiceName -StartupType Manual
    if ($whiteboardLegacyTask) {
      Enable-ScheduledTask -TaskName $whiteboardLegacyTaskName | Out-Null
      if ($whiteboardLegacyWasRunning) { Start-ScheduledTask -TaskName $whiteboardLegacyTaskName }
    }
    throw $whiteboardMigrationFailure
  }
} elseif ($Action -in @('Start','Restart','Stop')) {
  if (!$whiteboardService) { throw 'Native Whiteboard service is not installed. Run service.ps1 -Action Install as administrator.' }
  if ($Action -in @('Stop','Restart')) { Stop-WhiteboardService }
  if ($Action -ne 'Stop') {
    if ((Get-Service -Name $whiteboardServiceName).Status -ne 'Running') { Start-Service -Name $whiteboardServiceName }
    $whiteboardUrl = Wait-WhiteboardOnline
    [pscustomobject]@{ service = $whiteboardServiceName; state = 'Running'; url = $whiteboardUrl } | ConvertTo-Json -Compress
  }
} else {
  if (!$whiteboardService) { [pscustomobject]@{ installed = $false; service = $whiteboardServiceName } | ConvertTo-Json -Compress; exit 0 }
  $whiteboardNativeService = Get-CimInstance Win32_Service -Filter "Name = '$whiteboardServiceName'"
  $whiteboardStateFile = Join-Path $whiteboardRoot 'data\host-status.json'
  $whiteboardHostState = if (Test-Path -LiteralPath $whiteboardStateFile) { Get-Content -Raw -LiteralPath $whiteboardStateFile | ConvertFrom-Json } else { $null }
  [pscustomobject]@{ installed = $true; service = $whiteboardServiceName; state = $whiteboardNativeService.State; start_mode = $whiteboardNativeService.StartMode; account = $whiteboardNativeService.StartName; service_pid = $whiteboardNativeService.ProcessId; host = $whiteboardHostState } | ConvertTo-Json -Depth 4 -Compress
}
