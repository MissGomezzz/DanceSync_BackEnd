<#
.SYNOPSIS
  Turns the DIS-1 availability setup in Azure on or off, or shows its state.

.DESCRIPTION
  up      battle-service with 2 replicas always running and Redis with 1 replica.
  down    battle-service and Redis scale to zero: no compute is billed while nobody uses the app.
          Redis keeps nothing on disk, so rooms in progress are lost (finished results are in PostgreSQL).
  status  Scale settings, running replicas and the public health checks.

  -IncludePostgres also starts (up) or stops (down) the PostgreSQL flexible server.
  Azure starts a stopped flexible server again on its own after 7 days.

  Requires Azure CLI signed in (az login) with access to the resource group.

.EXAMPLE
  ./scripts/azure-availability.ps1 up -IncludePostgres
  ./scripts/azure-availability.ps1 status
  ./scripts/azure-availability.ps1 down -IncludePostgres
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('up', 'down', 'status')]
  [string]$Action,
  [switch]$IncludePostgres,
  [string]$ResourceGroup = 'rg-dancesync',
  [string]$PostgresServer = 'pgdancesyncsa33',
  [string]$GatewayUrl = 'https://api-gateway.wittybeach-53b16e7f.centralus.azurecontainerapps.io'
)

$ErrorActionPreference = 'Stop'

function Set-Scale([string]$App, [int]$Min, [int]$Max) {
  Write-Host "Scaling $App to min $Min / max $Max ..."
  az containerapp update --resource-group $ResourceGroup --name $App `
    --min-replicas $Min --max-replicas $Max --output none
  if ($LASTEXITCODE -ne 0) { throw "az containerapp update failed for $App" }
}

function Show-App([string]$App) {
  $scale = az containerapp show --resource-group $ResourceGroup --name $App `
    --query '{min: properties.template.scale.minReplicas, max: properties.template.scale.maxReplicas, revision: properties.latestRevisionName}' `
    --output json | ConvertFrom-Json
  $replicas = az containerapp replica list --resource-group $ResourceGroup --name $App `
    --query '[].{name: name, state: properties.runningState}' --output json | ConvertFrom-Json
  Write-Host ("{0,-16} min {1} / max {2}  revision {3}" -f $App, $scale.min, $scale.max, $scale.revision)
  foreach ($replica in @($replicas)) {
    if ($replica) { Write-Host ("    {0}  {1}" -f $replica.name, $replica.state) }
  }
}

function Show-Health([string]$Path) {
  try {
    $response = Invoke-WebRequest -Uri "$GatewayUrl$Path" -UseBasicParsing -TimeoutSec 60
    Write-Host ("GET {0} -> {1} {2}" -f $Path, $response.StatusCode, $response.Content)
  } catch {
    Write-Host ("GET {0} -> failed: {1}" -f $Path, $_.Exception.Message)
  }
}

switch ($Action) {
  'up' {
    if ($IncludePostgres) {
      Write-Host "Starting PostgreSQL $PostgresServer (takes a few minutes) ..."
      az postgres flexible-server start --resource-group $ResourceGroup --name $PostgresServer --output none
    }
    # Redis first, so the battle-service replicas find it when they start.
    Set-Scale 'redis' 1 1
    Set-Scale 'battle-service' 2 2
    Show-App 'redis'
    Show-App 'battle-service'
    Show-Health '/api/battles/health'
  }
  'down' {
    Set-Scale 'battle-service' 0 2
    Set-Scale 'redis' 0 1
    if ($IncludePostgres) {
      Write-Host "Stopping PostgreSQL $PostgresServer ..."
      az postgres flexible-server stop --resource-group $ResourceGroup --name $PostgresServer --output none
    }
    Show-App 'battle-service'
    Show-App 'redis'
  }
  'status' {
    Show-App 'api-gateway'
    Show-App 'users-service'
    Show-App 'battle-service'
    Show-App 'redis'
    $pgState = az postgres flexible-server show --resource-group $ResourceGroup --name $PostgresServer --query state --output tsv
    Write-Host "PostgreSQL $PostgresServer state: $pgState"
    # Only liveness is public through the gateway; readiness is probed inside the environment.
    Show-Health '/api/battles/health'
  }
}
