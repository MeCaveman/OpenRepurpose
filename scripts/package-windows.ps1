[CmdletBinding()]
param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\artifacts\windows-x64'),
  [string]$NodeRuntimeArchive
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Copy-DirectoryContents([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
  }
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = Get-Content -Raw (Join-Path $PSScriptRoot 'release\windows-runtime.json') | ConvertFrom-Json
$pinnedNodeVersion = (Get-Content -Raw (Join-Path $repositoryRoot '.node-version')).Trim()
if ($runtime.nodeVersion -ne $pinnedNodeVersion) {
  throw "windows-runtime.json Node version ($($runtime.nodeVersion)) must match .node-version ($pinnedNodeVersion)."
}

$output = [IO.Path]::GetFullPath($OutputDirectory)
if ($output -eq $repositoryRoot -or $repositoryRoot.StartsWith($output, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputDirectory must not be the repository or an ancestor of it.'
}
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
New-Item -ItemType Directory -Force -Path $output | Out-Null
$staging = Join-Path $output 'OpenRepurpose'
$app = Join-Path $staging 'app'
$runtimeDirectory = Join-Path $staging 'runtime'

Push-Location $repositoryRoot
try {
  corepack pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed with exit code $LASTEXITCODE." }
  corepack pnpm build
  if ($LASTEXITCODE -ne 0) { throw "Production build failed with exit code $LASTEXITCODE." }
  corepack pnpm --filter @openrepurpose/cli deploy --prod $app
  if ($LASTEXITCODE -ne 0) { throw "Production deployment failed with exit code $LASTEXITCODE." }
  & node (Join-Path $PSScriptRoot 'materialize-package.mjs') $app "$app-materialized"
  if ($LASTEXITCODE -ne 0) { throw 'Could not materialize deployed package links for ZIP distribution.' }
  Remove-Item -LiteralPath $app -Recurse -Force
  Move-Item -LiteralPath "$app-materialized" -Destination $app
} finally {
  Pop-Location
}
Copy-DirectoryContents (Join-Path $repositoryRoot 'apps\cli\dist') (Join-Path $app 'dist')

$webDistribution = Join-Path $repositoryRoot 'apps\web\dist'
& node (Join-Path $PSScriptRoot 'stage-web-distribution.mjs') $app $webDistribution
if ($LASTEXITCODE -ne 0) { throw 'Could not stage the web distribution beside deployed server packages.' }
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'THIRD_PARTY_NOTICES.md') -Destination $staging
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'LICENSE') -Destination $staging
Copy-DirectoryContents (Join-Path $repositoryRoot 'docs') (Join-Path $staging 'docs')
foreach ($relativePath in @('README.md', 'SECURITY.md', 'CONTRIBUTING.md')) {
  $sourcePath = Join-Path $repositoryRoot $relativePath
  $destinationPath = Join-Path $staging $relativePath
  Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
}

$runtimeArchive = if ([string]::IsNullOrWhiteSpace($NodeRuntimeArchive)) {
  Join-Path $output $runtime.archiveName
} else {
  [IO.Path]::GetFullPath($NodeRuntimeArchive)
}
if ([string]::IsNullOrWhiteSpace($NodeRuntimeArchive)) {
  Invoke-WebRequest -UseBasicParsing -Uri $runtime.archiveUrl -OutFile $runtimeArchive
}
if (!(Test-Path -LiteralPath $runtimeArchive)) { throw "Node runtime archive was not found: $runtimeArchive" }
if ((Get-Sha256 $runtimeArchive) -ne $runtime.sha256) {
  throw 'The Node runtime archive checksum does not match scripts/release/windows-runtime.json.'
}

$runtimeExtract = Join-Path $output 'runtime-extract'
Expand-Archive -LiteralPath $runtimeArchive -DestinationPath $runtimeExtract -Force
$runtimeSource = Join-Path $runtimeExtract ("node-v{0}-win-x64" -f $runtime.nodeVersion)
if (!(Test-Path -LiteralPath (Join-Path $runtimeSource 'node.exe'))) {
  throw 'The verified Node runtime archive does not contain node.exe at the expected path.'
}
Copy-DirectoryContents $runtimeSource $runtimeDirectory
Remove-Item -LiteralPath $runtimeExtract -Recurse -Force
if ([string]::IsNullOrWhiteSpace($NodeRuntimeArchive)) { Remove-Item -LiteralPath $runtimeArchive -Force }

$launcher = @'
@echo off
setlocal
set "OPENREPURPOSE_HOME=%~dp0"
"%OPENREPURPOSE_HOME%runtime\node.exe" "%OPENREPURPOSE_HOME%app\dist\index.js" %*
'@
Set-Content -LiteralPath (Join-Path $staging 'openrepurpose.cmd') -Value $launcher -NoNewline -Encoding ascii

$commit = try { (git -C $repositoryRoot rev-parse HEAD).Trim() } catch { 'unknown' }
$metadata = [ordered]@{
  artifactFormat = 'openrepurpose-windows-portable-v1'
  nodeRuntime = [ordered]@{ version = $runtime.nodeVersion; archiveSha256 = $runtime.sha256 }
  packageManager = 'pnpm 12.4.2'
  platform = 'win32-x64'
  sourceCommit = $commit
}
$metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $staging 'build-metadata.json') -Encoding utf8
$files = Get-ChildItem -LiteralPath $staging -Recurse -File | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } |
  ForEach-Object {
    $relative = $_.FullName.Substring($staging.Length + 1).Replace('\', '/')
    "$(Get-Sha256 $_.FullName)  $relative"
  }
$files | Set-Content -LiteralPath (Join-Path $staging 'SHA256SUMS.txt') -Encoding ascii
$zip = Join-Path $output 'OpenRepurpose-windows-x64.zip'
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory(
  $staging,
  $zip,
  [IO.Compression.CompressionLevel]::Optimal,
  $true
)
"$(Get-Sha256 $zip)  $(Split-Path -Leaf $zip)" |
  Set-Content -LiteralPath "$zip.sha256" -Encoding ascii -NoNewline
