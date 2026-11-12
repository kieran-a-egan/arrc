#requires -Version 7.0
<#
.SYNOPSIS
  Promote ARRC's existing roadmap issues into native GitHub milestones and sub-issues.
.DESCRIPTION
  Native Windows PowerShell 7; authenticated GitHub CLI required.
  Dry-run unless -Apply is supplied.
  -Project optionally creates an ARRC Roadmap GitHub Project; requires project scope.
.EXAMPLE
  pwsh -File scripts/configure-github.ps1
  pwsh -File scripts/configure-github.ps1 -Apply
  pwsh -File scripts/configure-github.ps1 -Apply -Project
#>
param(
  [switch] $Apply,
  [switch] $Project,
  [string] $Repository = "kieran-a-egan/arrc"
)
$ErrorActionPreference = "Stop"
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI (gh) not found. Install gh, then run gh auth login."
}
& gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "gh is not authenticated. Run gh auth login." }

function GhJson([string] $Method, [string] $Endpoint, $Payload) {
  $body = $Payload | ConvertTo-Json -Depth 12 -Compress
  $response = $body | & gh api -X $Method $Endpoint --input -
  if ($LASTEXITCODE -ne 0) { throw "GitHub API failed: $Method $Endpoint" }
  return ($response | ConvertFrom-Json)
}

$spec = @(
  @{ code = "M0"; title = "M0 — Foundation & feasibility"; description = "Windows-native foundations, contracts, Jev and Claude feasibility." },
  @{ code = "M1"; title = "M1 — Functional vertical slice"; description = "Request to verified code changes with approvals, checkpointing and recovery." },
  @{ code = "M2"; title = "M2 — Multi-agent orchestration"; description = "Concurrent delegation, quota management, ownership and recovery." },
  @{ code = "M3"; title = "M3 — Reliability & security"; description = "Daemon, TUI, validated containment and cross-platform verification." },
  @{ code = "M4"; title = "M4 — Optimisation & extensibility"; description = "More providers, optional remote workers and adaptive optimisation." }
)
$milestones = @(& gh api "repos/$Repository/milestones?state=all&per_page=100" | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw "Unable to list milestones in $Repository." }
foreach ($entry in $spec) {
  $existing = $milestones | Where-Object { $_.title -eq $entry.title } | Select-Object -First 1
  if ($existing) {
    Write-Host "Milestone already exists: $($entry.title)"
    continue
  }
  if (-not $Apply) {
    Write-Host "[dry-run] Create milestone: $($entry.title)"
    continue
  }
  $created = GhJson "POST" "repos/$Repository/milestones" @{
    title = $entry.title; description = $entry.description; state = "open"
  }
  $milestones += $created
  Write-Host "Created milestone: $($entry.title)"
}

$issues = @(& gh api "repos/$Repository/issues?state=all&per_page=100" | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw "Unable to list issues in $Repository." }
$tracker = @{}
foreach ($issue in $issues) {
  if ($issue.pull_request) { continue }
  if ($issue.title -match '^\[(M[0-4])\] ') { $tracker[$Matches[1]] = $issue }
}
foreach ($issue in $issues) {
  if ($issue.pull_request) { continue }
  if ($issue.title -notmatch '^\[(M[0-4])(?:-\d{2})?\] ') { continue }
  $stage = $Matches[1]
  $entry = $spec | Where-Object { $_.code -eq $stage } | Select-Object -First 1
  $milestone = $milestones | Where-Object { $_.title -eq $entry.title } | Select-Object -First 1
  if (-not $milestone) { continue }
  if ($issue.milestone -and $issue.milestone.number -eq $milestone.number) { continue }
  if (-not $Apply) {
    Write-Host "[dry-run] Assign issue #$($issue.number) to $($entry.title)"
  } else {
    GhJson "PATCH" "repos/$Repository/issues/$($issue.number)" @{ milestone = $milestone.number } | Out-Null
    Write-Host "Assigned #$($issue.number)"
  }
}

# Link already-created issues underneath their existing roadmap tracker issues.
# Errors are non-fatal since some GitHub accounts/configurations restrict sub-issues.
foreach ($issue in $issues) {
  if ($issue.pull_request) { continue }
  if ($issue.title -notmatch '^\[(M[0-4])-\d{2}\] ') { continue }
  $stage = $Matches[1]
  $parent = $tracker[$stage]
  if (-not $parent) { continue }
  if (-not $Apply) {
    Write-Host "[dry-run] Parent #$($parent.number) -> issue #$($issue.number)"
    continue
  }
  try {
    GhJson "POST" "repos/$Repository/issues/$($parent.number)/sub_issues" @{
      sub_issue_id = [int64]$issue.id
    } | Out-Null
    Write-Host "Linked issue #$($issue.number) to #$($parent.number)"
  } catch {
    Write-Warning "Could not create sub-issue link for #$($issue.number): $($_.Exception.Message)"
  }
}

if ($Project) {
  $owner = ($Repository -split "/")[0]
  if (-not $Apply) {
    Write-Host "[dry-run] Ensure GitHub Project 'ARRC Roadmap' exists for $owner."
  } else {
    # Keep GitHub CLI stderr visible so missing OAuth scope and API errors are actionable.
    $projectResult = & gh project list --owner $owner --format json
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "GitHub Projects unavailable. Review the gh project list error above; verify gh auth status, then run gh auth refresh -s project if the token lacks scope. If GH_TOKEN or GITHUB_TOKEN is set, that environment token may take precedence."
    } else {
      $projects = $projectResult | ConvertFrom-Json
      $existingProject = @($projects.projects | Where-Object { $_.title -eq "ARRC Roadmap" })
      if ($existingProject.Count -eq 0) {
        & gh project create --owner $owner --title "ARRC Roadmap" | Out-Host
        if ($LASTEXITCODE -ne 0) { Write-Warning "GitHub Project creation failed." }
      } else {
        Write-Host "ARRC Roadmap Project already exists."
      }
    }
  }
}
if ($Apply -and $Project) {
  $owner = ($Repository -split "/")[0]
  $updatedList = & gh project list --owner $owner --format json
  if ($LASTEXITCODE -eq 0) {
    $projectsNow = $updatedList | ConvertFrom-Json
    $selectedProject = $projectsNow.projects | Where-Object { $_.title -eq "ARRC Roadmap" } | Select-Object -First 1
    if ($selectedProject) {
      foreach ($issue in $issues) {
        if ($issue.pull_request) { continue }
        & gh project item-add $selectedProject.number --owner $owner --url $issue.html_url 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
          Write-Host "Skipped project item #$($issue.number) (may already be present)."
        }
      }
      Write-Host "Attempted to populate ARRC Roadmap with all existing issues."
    }
  }
}
Write-Host "Complete. Review https://github.com/$Repository"
