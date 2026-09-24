[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ArtifactDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$artifact = [IO.Path]::GetFullPath($ArtifactDirectory)
$zip = Join-Path $artifact 'OpenRepurpose-windows-x64.zip'
if (!(Test-Path -LiteralPath $zip)) { throw "Artifact ZIP was not found: $zip" }
$installationRoot = Join-Path $artifact 'clean-install'

# Defender and other filesystem scanners can briefly retain a newly-created ZIP on Windows.
# Retry extraction from a clean destination so a transient sharing violation cannot make the
# clean-profile release gate flaky.
$extractAttempts = 20
for ($attempt = 1; $attempt -le $extractAttempts; $attempt++) {
  if (Test-Path -LiteralPath $installationRoot) {
    Remove-Item -LiteralPath $installationRoot -Recurse -Force
  }
  try {
    Expand-Archive -LiteralPath $zip -DestinationPath $installationRoot -Force
    break
  } catch {
    if ($attempt -eq $extractAttempts) { throw }
    Start-Sleep -Seconds 1
  }
}
$launcher = Join-Path $installationRoot 'OpenRepurpose\openrepurpose.cmd'
if (!(Test-Path -LiteralPath $launcher)) { throw "Artifact launcher was not found: $launcher" }
$cleanProfile = Join-Path $artifact 'clean-user-profile'
if (Test-Path -LiteralPath $cleanProfile) {
  Remove-Item -LiteralPath $cleanProfile -Recurse -Force
}
$env:APPDATA = Join-Path $cleanProfile 'Roaming'
$env:LOCALAPPDATA = Join-Path $cleanProfile 'Local'
$env:TEMP = Join-Path $cleanProfile 'Temp'
$env:TMP = $env:TEMP
$env:PORT = '39100'
$env:APP_URL = 'http://127.0.0.1:39100'
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

& $launcher doctor
if ($LASTEXITCODE -ne 0) { throw "Packaged doctor failed with exit code $LASTEXITCODE." }
& $launcher jobs list --json
if ($LASTEXITCODE -ne 0) { throw "Packaged CLI job listing failed with exit code $LASTEXITCODE." }
$backupPath = Join-Path $cleanProfile 'release-candidate.orpbackup'
& $launcher backup create --output $backupPath --json
if ($LASTEXITCODE -ne 0) { throw "Packaged backup creation failed with exit code $LASTEXITCODE." }
& $launcher backup restore $backupPath --json
if ($LASTEXITCODE -ne 0) { throw "Packaged backup restore failed with exit code $LASTEXITCODE." }
$bundledNode = Join-Path $installationRoot 'OpenRepurpose\runtime\node.exe'
& $bundledNode (Join-Path $PSScriptRoot 'smoke-release-media.mjs') (Join-Path $installationRoot 'OpenRepurpose')
if ($LASTEXITCODE -ne 0) { throw "Packaged FFmpeg/subtitle smoke failed with exit code $LASTEXITCODE." }

$applicationEntry = Join-Path $installationRoot 'OpenRepurpose\app\dist\index.js'
$process = Start-Process -FilePath $bundledNode -ArgumentList $applicationEntry, 'start', '--headless' -PassThru -WindowStyle Hidden
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:39100/api/health'
      if ($response.StatusCode -eq 200 -and $response.Content -match '"status":"ok"') { break }
    } catch {}
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($null -eq $response -or $response.StatusCode -ne 200) { throw 'Packaged server did not become healthy.' }
  $ui = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:39100/'
  if ($ui.StatusCode -ne 200 -or $ui.Content -notmatch '<div id="root">') {
    throw 'Packaged server did not serve the production UI.'
  }
} finally {
  if (!$process.HasExited) { Stop-Process -Id $process.Id -Force }
}
