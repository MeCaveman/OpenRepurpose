[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][int]$Packet,
  [switch]$DryRun,
  [string]$Model,
  [ValidateSet('low', 'medium', 'high')][string]$Reasoning,
  [ValidateSet('architect', 'builder', 'routine')][string]$Role,
  [ValidateSet('normal', 'terra-high', 'sol-high', 'astra-high')][string]$Escalation = 'normal'
)

$arguments = @('packet', '--version', $Version, '--packet', $Packet, '--escalation', $Escalation)
if ($DryRun) { $arguments += '--dry-run' }
if ($Model) { $arguments += @('--model', $Model) }
if ($Reasoning) { $arguments += @('--reasoning', $Reasoning) }
if ($Role) { $arguments += @('--role', $Role) }

& python (Join-Path $PSScriptRoot 'roadmap_runner.py') @arguments
exit $LASTEXITCODE
