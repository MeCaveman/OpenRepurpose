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
if (Test-Path -LiteralPath $installationRoot) {
  Remove-Item -LiteralPath $installationRoot -Recurse -Force
}
Expand-Archive -LiteralPath $zip -DestinationPath $installationRoot -Force
$launcher = Join-Path $installationRoot 'OpenRepurpose\openrepurpose.cmd'
if (!(Test-Path -LiteralPath $launcher)) { throw "Artifact launcher was not found: $launcher" }
$cleanProfile = Join-Path $artifact 'clean-user-profile'
$env:APPDATA = Join-Path $cleanProfile 'Roaming'
$env:LOCALAPPDATA = Join-Path $cleanProfile 'Local'
$env:TEMP = Join-Path $cleanProfile 'Temp'
$env:TMP = $env:TEMP
$env:PORT = '39100'
$env:APP_URL = 'http://127.0.0.1:39100'

& $launcher doctor
if ($LASTEXITCODE -ne 0) { throw "Packaged doctor failed with exit code $LASTEXITCODE." }

$process = Start-Process -FilePath $launcher -ArgumentList 'start', '--headless' -PassThru -WindowStyle Hidden
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
