[CmdletBinding()]
param(
  [string]$Version,
  [int]$Packet,
  [switch]$DryRun,
  [string]$Model,
  [ValidateSet('low', 'medium', 'high')][string]$Reasoning,
  [ValidateSet('architect', 'builder', 'routine')][string]$Role,
  [ValidateSet('normal', 'terra-high', 'sol-high', 'astra-high')][string]$Escalation = 'normal'
)

$arguments = @('roadmap', '--escalation', $Escalation)
if ($Version) { $arguments += @('--version', $Version) }
if ($Packet) { $arguments += @('--packet', $Packet) }
if ($DryRun) { $arguments += '--dry-run' }
if ($Model) { $arguments += @('--model', $Model) }
if ($Reasoning) { $arguments += @('--reasoning', $Reasoning) }
if ($Role) { $arguments += @('--role', $Role) }

& python (Join-Path $PSScriptRoot 'roadmap_runner.py') @arguments
exit $LASTEXITCODE
