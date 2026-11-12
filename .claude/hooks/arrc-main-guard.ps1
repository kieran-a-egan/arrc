# Guard installed by the /arrc-issue skill. Main Opus thread delegates all
# repository and tool inspection to subagents. Subagents carry agent_id.
$ErrorActionPreference = "Stop"

function Deny([string] $Reason) {
  @{
    hookSpecificOutput = @{
      hookEventName = "PreToolUse"
      permissionDecision = "deny"
      permissionDecisionReason = $Reason
    }
  } | ConvertTo-Json -Depth 5 -Compress
}

try {
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
} catch {
  Deny "ARRC planner guard could not parse tool context; operation blocked."
  exit 0
}

# Only delegated agents may inspect code or execute tools. The root session
# has no agent_id, even when started with --agent; subagents do have one.
if (-not [string]::IsNullOrWhiteSpace([string]$payload.agent_id)) { exit 0 }

$coordinationTools = @(
  "Agent", "AskUserQuestion", "TodoWrite", "TaskCreate", "TaskGet",
  "TaskList", "TaskUpdate", "EndConversation"
)
if ($coordinationTools -contains [string]$payload.tool_name) { exit 0 }

Deny "ARRC main thread is Opus planning/coordination only. Delegate source reads, shell/GitHub access, edits, tests and review to a named subagent."
exit 0
