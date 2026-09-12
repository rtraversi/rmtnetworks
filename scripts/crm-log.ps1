<#
.SYNOPSIS
  Log a client activity and/or update a client's current status in the RMT CRM,
  from any terminal on this machine - regardless of which repo/directory you're in.

.DESCRIPTION
  Talks to the live rmtnetworks.com Netlify functions (client-activities.js,
  clients.js) over plain HTTPS using a static bearer token. Does NOT touch
  Supabase directly, so it works no matter which Supabase account is active
  locally.

  Reads RMT_SESSION_SECRET from C:\Sites\rmtnetworks\.env (fixed path, so this
  works even when your shell's cwd is some other client's directory).

.EXAMPLE
  # List clients (to find the exact name / see current status of everyone)
  .\crm-log.ps1 -List

.EXAMPLE
  # Log a note against a client
  .\crm-log.ps1 -Client "Acme" -Body "Sent revised proposal, awaiting signature."

.EXAMPLE
  # Log an email and update their current status in one shot
  .\crm-log.ps1 -Client "Acme" -Type email -Body "Sent invoice #204" -Status "Awaiting payment on invoice #204"

.EXAMPLE
  # Just update current status, no activity log line
  .\crm-log.ps1 -Client "Acme" -Status "Blocked - waiting on their DNS access"
#>

[CmdletBinding()]
param(
  [string]$Client,
  [string]$Body,
  [ValidateSet('note', 'email', 'call', 'meeting')]
  [string]$Type = 'note',
  [string]$Status,
  [switch]$List
)

$ErrorActionPreference = 'Stop'

$RepoRoot = 'C:\Sites\rmtnetworks'
$EnvFile  = Join-Path $RepoRoot '.env'
$BaseUrl  = 'https://rmtnetworks.com/.netlify/functions'

function Get-EnvValue($path, $key) {
  if (-not (Test-Path $path)) {
    throw "Env file not found at $path. Create it with a line: $key=<your-session-token>"
  }
  foreach ($line in Get-Content $path) {
    if ($line -match '^\s*#' -or $line -match '^\s*$') { continue }
    $parts = $line -split '=', 2
    if ($parts.Count -eq 2 -and $parts[0].Trim() -eq $key) {
      return $parts[1].Trim()
    }
  }
  throw "$key not found in $path"
}

$Token = Get-EnvValue $EnvFile 'RMT_SESSION_SECRET'
if ([string]::IsNullOrWhiteSpace($Token)) {
  throw "RMT_SESSION_SECRET is empty in $EnvFile - paste in the session token first."
}

$Headers = @{
  'Authorization' = "Bearer $Token"
  'Content-Type'  = 'application/json'
}

function Get-Clients {
  Invoke-RestMethod -Uri "$BaseUrl/clients" -Headers $Headers -Method Get
}

if ($List) {
  $clients = Get-Clients
  $clients |
    Sort-Object name |
    Select-Object name, status, current_status, status_updated_at |
    Format-Table -AutoSize
  return
}

if (-not $Client) {
  throw "Pass -Client <name> (or -List to see all clients)."
}

$clients = Get-Clients
$matches = $clients | Where-Object { $_.name -like "*$Client*" }

if ($matches.Count -eq 0) {
  throw "No client matching '$Client'. Run with -List to see exact names."
}
if ($matches.Count -gt 1) {
  Write-Host "Multiple clients match '$Client':" -ForegroundColor Yellow
  $matches | Select-Object name | Format-Table -AutoSize
  throw "Be more specific."
}

$clientRow = $matches[0]
$clientId  = $clientRow.id

if ($Body) {
  $activityPayload = @{
    client_id = $clientId
    type      = $Type
    body      = $Body
  } | ConvertTo-Json

  Invoke-RestMethod -Uri "$BaseUrl/client-activities" -Headers $Headers -Method Post -Body $activityPayload | Out-Null
  Write-Host "Logged [$Type] for $($clientRow.name): $Body" -ForegroundColor Green
}

if ($Status) {
  $statusPayload = @{
    current_status    = $Status
    status_updated_at = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json

  Invoke-RestMethod -Uri "$BaseUrl/clients?id=$clientId" -Headers $Headers -Method Patch -Body $statusPayload | Out-Null
  Write-Host "Status updated for $($clientRow.name): $Status" -ForegroundColor Cyan
}

if (-not $Body -and -not $Status) {
  Write-Host "Nothing to do - pass -Body and/or -Status." -ForegroundColor Yellow
}
