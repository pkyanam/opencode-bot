param([string]$ControlUrl,[string]$PairingToken,[string]$Name,[string]$Version=$env:OCBOT_VERSION,[switch]$Uninstall,[switch]$Update)
$ErrorActionPreference = 'Stop'
$base = if ($env:OCBOT_RELEASE_BASE) { $env:OCBOT_RELEASE_BASE } else { 'https://github.com/pkyanam/opencode-bot' }
$root = if ($env:OCBOT_NODE_HOME) { $env:OCBOT_NODE_HOME } else { Join-Path $env:LOCALAPPDATA 'opencode-bot-node' }
$configDir = if ($env:OCBOT_NODE_CONFIG_DIR) { $env:OCBOT_NODE_CONFIG_DIR } else { Join-Path $env:APPDATA 'opencode-bot-node' }
$config = if ($env:OCBOT_NODE_CONFIG) { $env:OCBOT_NODE_CONFIG } else { Join-Path $configDir 'node.json' }
function Stop-Node { schtasks /End /TN 'OpenCode Bot Node' 2>$null | Out-Null; schtasks /Delete /TN 'OpenCode Bot Node' /F 2>$null | Out-Null }
if ($Uninstall) { Stop-Node; if (Test-Path (Join-Path $root '.opencode-bot-node-owned')) { Remove-Item -Recurse -Force $root } else { Write-Output "Preserving $root because its ownership marker is missing." }; if (Test-Path (Join-Path $configDir '.opencode-bot-node-owned')) { Remove-Item -Force $config,$(Join-Path $configDir '.opencode-bot-node-owned') -ErrorAction SilentlyContinue; Remove-Item -Recurse -Force (Join-Path $configDir 'state'),(Join-Path $configDir 'workspace') -ErrorAction SilentlyContinue } else { Write-Output "Preserving $configDir because its ownership marker is missing." }; Write-Output 'Node removed; revoke it in Settings if it is still listed.'; exit 0 }
if ($Update -or (Test-Path $config)) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  $updater = Join-Path $root 'bundle/scripts/node-update.mjs'
  $bootstrapTmp = $null
  if (!$nodeCommand) { throw 'Node.js is required to update an existing node.' }
  if (!(Test-Path $updater)) {
    $bootstrapTmp = Join-Path ([IO.Path]::GetTempPath()) ('opencode-node-update-bootstrap-' + [guid]::NewGuid()); New-Item -ItemType Directory -Path $bootstrapTmp | Out-Null
    $manifestPath = Join-Path $bootstrapTmp 'manifest.json'; $manifestUrl = if ($Version) { "$base/releases/download/$Version/node-bundle-manifest.json" } else { "$base/releases/latest/download/node-bundle-manifest.json" }; Invoke-WebRequest $manifestUrl -OutFile $manifestPath; $m = Get-Content $manifestPath -Raw | ConvertFrom-Json
    if ($m.schemaVersion -ne 1 -or $m.version -notmatch '^v\d+\.\d+\.\d+$' -or $m.commit -notmatch '^[0-9a-f]{40}$' -or $m.archive.file -ne 'node-bundle.tar.gz' -or $m.archive.sha256 -notmatch '^[0-9a-f]{64}$' -or [int64]$m.archive.size -le 0) { throw 'Invalid node release manifest' }
    $archivePath = Join-Path $bootstrapTmp 'node-bundle.tar.gz'; Invoke-WebRequest "$base/releases/download/$($m.version)/$($m.archive.file)" -OutFile $archivePath; if ((Get-FileHash $archivePath -Algorithm SHA256).Hash.ToLower() -ne $m.archive.sha256.ToLower() -or (Get-Item $archivePath).Length -ne [int64]$m.archive.size) { throw 'Node bundle checksum or size verification failed' }
    $extract = Join-Path $bootstrapTmp 'bundle'; New-Item -ItemType Directory -Path $extract | Out-Null; tar -xzf $archivePath -C $extract; if ($LASTEXITCODE -ne 0) { throw 'Node archive extraction failed' }; $updater = Join-Path $extract 'scripts/node-update.mjs'; if (!(Test-Path $updater)) { throw 'Verified release does not contain the node updater.' }
  }
  $arguments = @($updater,'--node-home',$root,'--config',$config)
  if ($Version) { $arguments += @('--version',$Version) }
  if ($bootstrapTmp) { $arguments += @('--manifest',(Join-Path $bootstrapTmp 'manifest.json'),'--archive',(Join-Path $bootstrapTmp 'node-bundle.tar.gz')) }
  & $nodeCommand.Source @arguments
  if ($LASTEXITCODE -ne 0) { throw 'Node update failed.' }
  if ($bootstrapTmp) { Remove-Item -Recurse -Force $bootstrapTmp -ErrorAction SilentlyContinue }
  exit 0
}
if (!$Name) { $Name = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { (hostname) } }
if (!$ControlUrl -or !$PairingToken) { throw 'ControlUrl and PairingToken are required.' }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('opencode-node-' + [guid]::NewGuid()); New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $nodeVersion = if ($env:OCBOT_NODE_VERSION) { $env:OCBOT_NODE_VERSION } else { '24.14.0' }; $nodeRoot = Join-Path $root "node-v$nodeVersion"; $node = Join-Path $nodeRoot 'node.exe'; $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue; $systemNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue; $npmCommand = $null
  if (!$systemNode -or !$systemNpm -or (& $systemNode.Source -p 'Number(process.versions.node.split(".")[0])') -lt 24) {
    $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }; $zip = "node-v$nodeVersion-win-$arch.zip"; Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/$zip" -OutFile (Join-Path $tmp $zip); Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" -OutFile (Join-Path $tmp 'SHASUMS256.txt'); $line=(Get-Content (Join-Path $tmp 'SHASUMS256.txt') | Where-Object { $_ -match " $([regex]::Escape($zip))$" }); if ((Get-FileHash (Join-Path $tmp $zip) -Algorithm SHA256).Hash.ToLower() -ne $line.Split(' ')[0].ToLower()) { throw 'Node.js checksum verification failed' }; Expand-Archive (Join-Path $tmp $zip) -DestinationPath $tmp; New-Item -ItemType Directory -Force -Path $root | Out-Null; Remove-Item -Recurse -Force $nodeRoot -ErrorAction SilentlyContinue; Move-Item (Join-Path $tmp ([IO.Path]::GetFileNameWithoutExtension($zip))) $nodeRoot
  } else { $node = $systemNode.Source }
  $npmCommand = if ($node -eq (Join-Path $nodeRoot 'node.exe')) { Join-Path $nodeRoot 'npm.cmd' } else { $systemNpm.Source }
  $env:PATH = (Split-Path $node) + [IO.Path]::PathSeparator + $env:PATH
  $manifestUrl = if ($Version) { "$base/releases/download/$Version/node-bundle-manifest.json" } else { "$base/releases/latest/download/node-bundle-manifest.json" }; Invoke-WebRequest $manifestUrl -OutFile (Join-Path $tmp 'manifest.json'); $m=Get-Content (Join-Path $tmp 'manifest.json') | ConvertFrom-Json; if ($m.schemaVersion -ne 1 -or $m.archive.file -ne 'node-bundle.tar.gz' -or $m.archive.sha256 -notmatch '^[0-9a-f]{64}$') { throw 'Invalid node release manifest' }; $archive=Join-Path $tmp 'node-bundle.tar.gz'; Invoke-WebRequest "$base/releases/download/$($m.version)/node-bundle.tar.gz" -OutFile $archive; if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLower() -ne $m.archive.sha256.ToLower()) { throw 'Node bundle checksum verification failed' }
  if ((Get-Item $archive).Length -ne [int64]$m.archive.size) { throw 'Node bundle size verification failed' }; $bundle=Join-Path $root 'bundle'; New-Item -ItemType Directory -Force -Path $root | Out-Null; Remove-Item -Recurse -Force $bundle -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force -Path $bundle | Out-Null; tar -xzf $archive -C $bundle; if ($LASTEXITCODE -ne 0) { throw 'Node archive extraction failed' }; New-Item -ItemType File -Force -Path (Join-Path $root '.opencode-bot-node-owned') | Out-Null; $bundle=Join-Path $root 'bundle'; New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  Set-Content -Path (Join-Path $root 'bundle-version.json') -Value (ConvertTo-Json @{ version=$m.version; commit=$m.commit }) -Encoding utf8
  $reuse = $false; if (Test-Path $config) { try { $saved = Get-Content $config -Raw | ConvertFrom-Json; $savedUrl = [Uri]$saved.controlUrl; $requestedUrl = [Uri]$ControlUrl; $reuse = [bool]($saved.nodeId -and $saved.nodeSecret -and $saved.runnerToken -and $savedUrl.GetLeftPart([UriPartial]::Authority) -eq $requestedUrl.GetLeftPart([UriPartial]::Authority) -and $savedUrl.AbsolutePath.TrimEnd('/') -eq $requestedUrl.AbsolutePath.TrimEnd('/')) } catch { $reuse = $false } }
  if (!$reuse) { & $node (Join-Path $bundle 'scripts/node-agent.mjs') register --control-url $ControlUrl --pairing-token $PairingToken --name $Name --config $config | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Node registration failed' } } else { Write-Output 'Using the saved node connection.' }
  New-Item -ItemType File -Force -Path (Join-Path $configDir '.opencode-bot-node-owned') | Out-Null; & $npmCommand ci --prefix (Join-Path $bundle 'runner') --omit=dev --no-audit --fund=$false | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Runner dependency installation failed' }; New-Item -ItemType Junction -Path (Join-Path $bundle 'node_modules') -Target (Join-Path $bundle 'runner/node_modules') -Force | Out-Null
  $browserPath = Join-Path $root 'browsers'; New-Item -ItemType Directory -Force -Path $browserPath | Out-Null; $env:PLAYWRIGHT_BROWSERS_PATH = $browserPath; & $npmCommand exec --prefix (Join-Path $bundle 'runner') --offline -- playwright install --no-shell chromium | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Private Chromium installation failed' }
  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$(Join-Path $bundle 'scripts/node-agent.mjs')`" start --config `"$config`""; Register-ScheduledTask -TaskName 'OpenCode Bot Node' -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Description 'OpenCode Bot outbound owned computer node' -Force | Out-Null; Start-ScheduledTask -TaskName 'OpenCode Bot Node'; Write-Output "Paired $Name and started the node service."
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
