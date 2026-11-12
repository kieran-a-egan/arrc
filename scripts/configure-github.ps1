#requires -Version 7.0
<#
.SYNOPSIS
  Assign existing ARRC milestones and create/populate the GitHub Project.
.DESCRIPTION
  Uses existing M0-M4 milestones. Does NOT create milestones.
  Existing issues already have correct parent/sub-issue relationships.
  Read-only by default; pass -Apply to update GitHub.
.EXAMPLE
  pwsh -File scripts/configure-github.ps1 -Project
  pwsh -File scripts/configure-github.ps1 -Apply -Project
#>
param(
  [switch] $Apply,
  [switch] $Project,
  [string] $Repository = "kieran-a-egan/arrc"
)
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI (gh) not found. Install gh and run gh auth login."
}
$authOutput = & gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "GitHub CLI is not authenticated: $($authOutput -join ' ')"
}

function Invoke-GhJson {
  param([Parameter(Mandatory)][string[]] $CliArgs)
  $output = & gh @CliArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "gh $($CliArgs -join ' ') failed: $($output -join ' ')"
  }
  $json = ([string[]]$output) -join [Environment]::NewLine
  if ([string]::IsNullOrWhiteSpace($json)) { return $null }
  $data = ConvertFrom-Json -InputObject $json -Depth 40
  return $data
}

$owner = ($Repository -split "/")[0]
$issues = @(Invoke-GhJson -CliArgs @("api", "repos/$Repository/issues?state=all&per_page=100"))
$issues = @($issues | Where-Object { -not $_.pull_request })
Write-Host "Found $($issues.Count) existing issues in $Repository."

# Project setup happens independently of milestone assignment.
if ($Project) {
  $projectInfo = Invoke-GhJson -CliArgs @("project", "list", "--owner", $owner, "--format", "json", "--limit", "100")
  $existingProjects = @($projectInfo.projects | Where-Object { $_.title -eq "ARRC Roadmap" })
  if ($existingProjects.Count -gt 1) {
    throw "Multiple Projects are titled ARRC Roadmap. Select one manually."
  }

  if ($existingProjects.Count -eq 0 -and -not $Apply) {
    Write-Host "[dry-run] Create GitHub Project: ARRC Roadmap."
  }
  if ($existingProjects.Count -eq 0 -and $Apply) {
    $createOutput = & gh project create --owner $owner --title "ARRC Roadmap" 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Project creation failed: $($createOutput -join ' ')"
    }
    Write-Host "Created ARRC Roadmap Project."
    $projectInfo = Invoke-GhJson -CliArgs @("project", "list", "--owner", $owner, "--format", "json", "--limit", "100")
    $existingProjects = @($projectInfo.projects | Where-Object { $_.title -eq "ARRC Roadmap" })
  }

  if ($existingProjects.Count -eq 1) {
    $projectNumber = [int]$existingProjects[0].number
    Write-Host "Using GitHub Project #$projectNumber."
    $projectItems = Invoke-GhJson -CliArgs @("project", "item-list", "$projectNumber", "--owner", $owner, "--format", "json", "--limit", "100")
    $knownUrls = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($item in @($projectItems.items)) {
      if ($item.content.url) { [void]$knownUrls.Add([string]$item.content.url) }
    }
    $added = 0
    foreach ($issue in $issues) {
      $issueUrl = [string]$issue.html_url
      if ($knownUrls.Contains($issueUrl)) { continue }
      if (-not $Apply) {
        Write-Host "[dry-run] Add issue #$($issue.number) to Project #$projectNumber."
        continue
      }
      $addOutput = & gh project item-add "$projectNumber" --owner $owner --url $issueUrl 2>&1
      if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not add issue #$($issue.number): $($addOutput -join ' ')"
      } else {
        $added++
      }
    }
    if ($Apply) { Write-Host "Added $added missing issues to ARRC Roadmap." }
  }
}

# Existing GitHub milestones can have punctuation/encoding differences.
# Match by their stable M0-M4 prefix and NEVER attempt to create another.
$milestones = @(Invoke-GhJson -CliArgs @("api", "repos/$Repository/milestones?state=all&per_page=100"))
$milestoneByStage = @{}
foreach ($stage in @("M0", "M1", "M2", "M3", "M4")) {
  $matchesForStage = @($milestones | Where-Object { $_.title -match "^\s*$stage\b" })
  if ($matchesForStage.Count -eq 1) {
    $milestoneByStage[$stage] = $matchesForStage[0]
    Write-Host "Found $stage milestone #$($matchesForStage[0].number): $($matchesForStage[0].title)"
  } elseif ($matchesForStage.Count -eq 0) {
    Write-Warning "No milestone begins with $stage. Existing milestone titles: $((@($milestones | ForEach-Object { $_.title })) -join '; ')"
  } else {
    Write-Warning "Multiple milestones begin with $stage; skipping that stage to avoid an incorrect assignment."
  }
}

$assigned = 0
$missing = 0
foreach ($issue in $issues) {
  if ($issue.title -match '^\[(M[0-4])(?:-\d{2})?\]') {
    $stage = $Matches[1]
  } else {
    continue
  }
  if (-not $milestoneByStage.ContainsKey($stage)) {
    $missing++
    continue
  }
  $milestone = $milestoneByStage[$stage]
  $number = [int]$milestone.number
  if ($issue.milestone -and [int]$issue.milestone.number -eq $number) { continue }
  if (-not $Apply) {
    Write-Host "[dry-run] Assign issue #$($issue.number) to $stage milestone #$number."
    continue
  }
  $editOutput = & gh api -X PATCH "repos/$Repository/issues/$($issue.number)" -F "milestone=$number" --silent 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Could not assign issue #$($issue.number): $($editOutput -join ' ')"
  } else {
    $assigned++
  }
}
if ($missing -gt 0) {
  Write-Warning "$missing issues were not assigned because the corresponding milestone was missing or ambiguous."
}
if ($Apply) { Write-Host "Assigned milestones to $assigned issues." }
Write-Host "Setup complete. Review https://github.com/$Repository"
