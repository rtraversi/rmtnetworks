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

.EXAMPLE
  # Full wrap-for-the-day update - status line plus the structured detail fields.
  # Any field you omit is left as-is (merged, not overwritten).
  .\crm-log.ps1 -Client "Acme" -Status "Awaiting logo files" `
    -LastHandoff "Finished homepage layout, about to start the contact form" `
    -NextUp "Wire up the contact form once logo files are in" `
    -WaitingOn "Client to send final logo files (asked 9/12)" `
    -SentPending "Sent homepage preview link 9/12" `
    -ClientQuestions "They asked whether we can support a Spanish version"

.EXAMPLE
  # Set the pipeline stage pill shown on the Command Center board
  .\crm-log.ps1 -Client "Acme" -Stage "Building"

.EXAMPLE
  # Print everything currently known about a client (no activity logged)
  .\crm-log.ps1 -Client "Acme" -Show
#>

[CmdletBinding()]
param(
  [string]$Client,
  [string]$Body,
  [ValidateSet('note', 'email', 'call', 'meeting')]
  [string]$Type = 'note',
  [string]$Status,
  [ValidateSet('Pending Client', 'Building', 'On-Hold', 'Completed', 'Pending Payment', 'New Build')]
  [string]$Stage,
  [string]$LastHandoff,
  [string]$NextUp,
  [string]$WaitingOn,
  [string]$SentPending,
  [string]$ClientQuestions,
  [switch]$Show,
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

function Show-Client($row) {
  $d = $row.status_detail
  Write-Host ""
  Write-Host "$($row.name)" -ForegroundColor Cyan
  Write-Host "  Stage:             $($row.project_status)"
  Write-Host "  Status:            $($row.current_status)"
  Write-Host "  Updated:           $($row.status_updated_at)"
  Write-Host "  Last handoff:      $($d.last_handoff)"
  Write-Host "  Next up:           $($d.next_up)"
  Write-Host "  Waiting on:        $($d.waiting_on)"
  Write-Host "  Sent, pending:     $($d.sent_pending)"
  Write-Host "  Client questions:  $($d.client_questions)"
  $openTasks = $row.client_tasks | Where-Object { $_.status -eq 'open' }
  Write-Host "  Open tasks:        $($openTasks.Count)"
  foreach ($t in $openTasks) { Write-Host "    - $($t.title) $(if ($t.due_date) { "(due $($t.due_date))" })" }
  Write-Host ""
}

$didWrite = $false

if ($Body) {
  $activityPayload = @{
    client_id = $clientId
    type      = $Type
    body      = $Body
  } | ConvertTo-Json

  Invoke-RestMethod -Uri "$BaseUrl/client-activities" -Headers $Headers -Method Post -Body $activityPayload | Out-Null
  Write-Host "Logged [$Type] for $($clientRow.name): $Body" -ForegroundColor Green
  $didWrite = $true
}

$detailFields = @{
  last_handoff     = $LastHandoff
  next_up          = $NextUp
  waiting_on       = $WaitingOn
  sent_pending     = $SentPending
  client_questions = $ClientQuestions
}
$hasDetailUpdate = ($detailFields.Values | Where-Object { $_ }).Count -gt 0

$StageMap = @{
  'Pending Client'  = 'pending_client'
  'Building'        = 'building'
  'On-Hold'         = 'on_hold'
  'Completed'       = 'completed'
  'Pending Payment' = 'pending_payment'
  'New Build'       = 'new_build'
}

if ($Status -or $Stage -or $hasDetailUpdate) {
  $patch = @{ status_updated_at = (Get-Date).ToUniversalTime().ToString('o') }

  if ($Status) { $patch.current_status = $Status }
  if ($Stage) { $patch.project_status = $StageMap[$Stage] }

  if ($hasDetailUpdate) {
    # Merge onto the existing status_detail rather than overwrite it - each field
    # you don't pass keeps whatever was there before.
    $merged = @{}
    if ($clientRow.status_detail) {
      $clientRow.status_detail.PSObject.Properties | ForEach-Object { $merged[$_.Name] = $_.Value }
    }
    foreach ($key in $detailFields.Keys) {
      if ($detailFields[$key]) { $merged[$key] = $detailFields[$key] }
    }
    $patch.status_detail = $merged
  }

  $patchJson = $patch | ConvertTo-Json -Depth 5
  Invoke-RestMethod -Uri "$BaseUrl/clients?id=$clientId" -Headers $Headers -Method Patch -Body $patchJson | Out-Null

  if ($Status) { Write-Host "Status updated for $($clientRow.name): $Status" -ForegroundColor Cyan }
  if ($Stage) { Write-Host "Stage updated for $($clientRow.name): $Stage" -ForegroundColor Cyan }
  if ($hasDetailUpdate) { Write-Host "Detail updated for $($clientRow.name)." -ForegroundColor Cyan }
  $didWrite = $true
}

if (-not $didWrite -and -not $Show) {
  Write-Host "Nothing to do - pass -Body, -Status, -Stage, and/or a detail field. See -Show or -List." -ForegroundColor Yellow
}

if ($Show) {
  # Re-fetch so a write earlier in this same call is reflected immediately.
  $fresh = if ($didWrite) { (Get-Clients | Where-Object { $_.id -eq $clientId }) } else { $clientRow }
  Show-Client $fresh
}
