# Spike 0002: Claude Code permission enforcement and subscription usage reporting (M0-08, #13)

## Purpose and scope

Show whether ARRC can intercept every Claude Code tool action **before execution** with the deterministic policy kernel (M0-05), classify the auth/billing identity without touching credentials, and observe subscription limit signals.

Non-goal respected: enforcement is a hook that denies in code. Nothing relies on prompt or model instructions.

**Evidence level.** No live run was made for this spike. Every "pass" below is against the fake-claude fixture (`packages/core/test/fixtures/fake-claude.mjs`), which emulates the *documented* hook contract (Claude Code 2.1.323 docs). Real-CLI behaviour is **unverified** until the steps in "Remaining live verification" are run. Rate-limit events are undocumented upstream (shape taken from M0-07 observation).

## What was built

- `packages/core/src/claude-gate.ts`: pure `gateToolUse(policy, hookInput, context)` plus a stdin/stdout entrypoint (`node claude-gate.ts <policy.json>`). Principal is host-supplied (`model:claude-code`), never read from hook input. Output is only `allow` or `deny`, never `ask`. Entrypoint exits 0 with hook JSON; any failure (bad policy, bad JSON, exception) writes to stderr and exits 2 (blocking).
- `claude-probe.ts`: `buildGateArgs()` (`--settings` PreToolUse hook with matcher `*`, plus `--permission-prompts none` and `--disallowedTools Bash,PowerShell,WebFetch,WebSearch,Task,Agent,mcp__*,ListMcpResourcesTool,ReadMcpResourceTool`), refusal of bypass args in `runClaude`, `classifyAuth()`, `parseRateLimit()`, new `--gate <policy.json>` flag for `--live`.
- Tool mapping (everything else denied): `Read`, `Glob`, `Grep` -> `fs.read`; `Write`, `Edit`, `MultiEdit`, `NotebookEdit` -> `fs.write`. `Glob`/`Grep` with no path use the hook's `cwd` (fail-closed if absent); `Bash`/`PowerShell` are denied outright: a shell string cannot be mediated by a path/argv policy. `WebFetch`, `WebSearch`, `Task`/`Agent`, `mcp__*`, unknown tools, malformed input and non-`PreToolUse` events are denied. `process.spawn` is never produced by the gate, so SUPPORTED_ENFORCEMENT is untouched.
- Each tool reads only its own path field (`file_path`, `notebook_path`, or `path` for Glob/Grep); no cross-field fallback. `Glob` patterns containing `{ } ~ :` or `..`, or absolute, are denied.
- `claude-gate.ts` legitimately reads stdin and the policy file, so it is outside the M0-07 source-grep guard (which still covers `claude-probe.ts`). Env-name matching in `classifyAuth` is case-insensitive on win32 only; `fingerprint` and `classifyAuth` share `envPresence` (case-insensitive on win32, exact-match elsewhere; changed from always case-insensitive in M0-07's fingerprint).
- Limits inherited from the kernel: paths are lexical, Windows drive-absolute, backslash only (forward-slash or relative paths from Claude are denied); no symlink/junction resolution (executor-layer work).

## Integration requirements (authorised integration)

1. Never pass `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `bypassPermissions`, `--bare`, `--safe-mode`, `--managed-settings` or `--setting-sources`. `--bare`/`--safe-mode` disable hooks; bypass modes still run hooks but widen what the CLI would otherwise refuse. `runClaude` refuses these (fixture-tested). Recommend also setting managed `permissions.disableBypassPermissionsMode`.
2. Hook `allow` does not override Claude deny rules, and `-p` defaults to manual mode (unapproved actions denied; `--permission-prompts none` makes that explicit). Both are the safe direction.
3. `-p` skips the workspace trust dialog, so project `.claude/settings.json` hooks and `.mcp.json` servers in the cwd run. Run sessions in an isolated cwd that ARRC controls.
4. Unset `ANTHROPIC_API_KEY` (and `ANTHROPIC_AUTH_TOKEN`) unless API billing is intended: in `-p` mode the key is always used when present, even if logged in to Pro/Max.
5. The hook uses exec form (`{"type":"command","command":<process.execPath>,"args":[<gate script>,<policy>]}`): no shell, so no Git Bash dependency and no quoting rules. Per the installed binary, a shell-form command made only of quoted strings starts nothing under PowerShell without Git Bash, hence exec form. Exec form is unverified live.
6. Hook script must be a built `.js` (or Node >= 24 `.ts`) reachable by the user running Claude. Only exit 2 blocks by default; other non-zero exits are non-blocking and the tool proceeds. The gate exits 2 on its own internal errors (bad policy, bad JSON, exception). Launch failures (missing script, Node without type stripping, shell quoting, timeout) never reach the gate, so `buildGateArgs` sets `"onFailure":"block"` on the handler (documented, v2.1.295+; unverified live) and passes `--disallowedTools Bash,PowerShell,WebFetch,WebSearch,Task,Agent,mcp__*,ListMcpResourcesTool,ReadMcpResourceTool` (deny rules apply regardless of hooks; the `mcp__*` wildcard form is unverified, the documented forms are `mcp__server` and `mcp__server__*`; `ListMcpResourcesTool` and `ReadMcpResourceTool` have no `mcp__` prefix so are listed explicitly). Residual risk: if `onFailure` is not honoured, or hooks are disabled by settings outside ARRC's control (item 8), read tools (Read/Glob/Grep) could proceed under default `-p` rules after a hook launch failure, and Write/Edit too under `bypassPermissions`, broad allow rules, or `--permission-mode acceptEdits` / `auto` configured via settings. `--permission-prompts none` is also unverified live.
7. `runClaude` inspects only `extraArgs` (not the prompt) and refuses bypass flags (also `--flag=value` forms), `--permission-mode bypassPermissions`, a second `--settings`, any `--setting-sources` and `--managed-settings` (hidden flag in CLI 2.1.323; may set `allowManagedHooksOnly`/`disableAllHooks`; effect on hooks unverified, refused as a precaution), so callers cannot replace the gate settings via args. It also refuses a caller `env` that sets `CLAUDE_CODE_SIMPLE` or `CLAUDE_CODE_SAFE_MODE` and strips both from the inherited environment (item 8). It does not control settings files. Refusing `--setting-sources` is a deliberate trade-off: it stops callers swapping out the gate settings, but it also means user/project/local sources always load (see item 8). Restricting sources could be a future mitigation once verified live.
8. Settings and environment outside ARRC's control can switch the gate off or limit it: `disableAllHooks` (user settings or `--settings`), `allowManagedHooksOnly` / safe mode via managed policy, `strictPluginOnlyCustomization`, and the env vars `CLAUDE_CODE_SIMPLE` (set by `--bare`) and `CLAUDE_CODE_SAFE_MODE` (set by `--safe-mode`) mean the hook never runs and `onFailure` never triggers. The probe strips both env vars from the inherited environment and refuses them in caller `env` (fixture-tested; found by string search of CLI 2.1.323, not live-verified); the settings keys it cannot control. `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG` and `CLAUDE_CODE_PERSONAL_HOOKS_OFF` can also stop "your own" hooks (unverified whether `--settings` hooks count); the probe does not strip them. `CLAUDE_CODE_RESTRICTED`/`--restricted` only confines file tools and does not disable hooks. The integration must ensure user settings (`~/.claude/settings.json`), local/project settings and managed policy do not set `disableAllHooks`, `allowManagedHooksOnly`, `permissions.defaultMode: bypassPermissions` or broad allow rules, and the host must verify or isolate that config (e.g. an isolated Claude config dir; unverified mitigation). `fingerprint` only records existence of settings files, not their contents.

## Auth and billing classification

`classifyAuth(env, init?)` is presence-only (env values are never read or returned) and follows documented precedence: cloud (`CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY`) > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `apiKeyHelper` > `CLAUDE_CODE_OAUTH_TOKEN` (subscription) > `/login`.

| Input | billing | possibleCharges |
|---|---|---|
| cloud flag set | `cloud` | true |
| AUTH_TOKEN or API_KEY set (even with OAuth token) | `api`, `apiKeyOverridesSubscription=true` | true |
| `init.apiKeySource` = `apiKeyHelper`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` (env presence is checked first; key may come from a settings `env` block) | `api`; `apiKeyOverridesSubscription=true` for the two env names | true |
| only `CLAUDE_CODE_OAUTH_TOKEN` | `subscription` | `"unknown"` (extra-usage billing may apply) |
| nothing set | `unknown` | `"unknown"` |

Not determinable without reading settings or credentials (deliberately not done): `apiKeyHelper` configured in settings, and whether a `/login` subscription exists. `init.apiKeySource` is recorded raw; its value for a subscription login is unverified, so it is only interpreted for `apiKeyHelper`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` (`ANTHROPIC_AUTH_TOKEN` as an init value is unconfirmed). `result.total_cost_usd` is recorded as `costUsdEstimate`: a client-side list-price estimate, not a bill.

## Usage signals

`rate_limit_event.rate_limit_info` (`status`, `resetsAt` unix seconds, `rateLimitType`, `utilization`) is parsed into `RunResult.rateLimits`. Each field is type-checked and becomes `"unknown"` when absent or mistyped; no inference or defaults. Seen live in M0-07 (event present, payload then dropped); payload contents are unverified live. Not available: plan tier, absolute quota remaining, a stable schema (undocumented).

## Pass/fail matrix

Status: `pass (fixture)` = automated test against fake-claude; `pass (live)` = recorded evidence (none yet); `unverified`; `blocked`/`unsupported`.

| Transport | Aspect | Status | Notes |
|---|---|---|---|
| CLI stream-json + PreToolUse hook | fs read (Read/Glob/Grep) | pass (fixture) | allow in policy; deny outside, escapes, relative, forward slash |
| | fs write (Write/Edit/MultiEdit/NotebookEdit) | pass (fixture) | tool "executed" marker written only on allow |
| | shell (Bash/PowerShell) | pass (fixture): denied | unsupported by design; cannot be mediated |
| | web (WebFetch/WebSearch) | pass (fixture): denied | unsupported by design |
| | subagent (Task/Agent) | pass (fixture): denied | subagent tool calls also fire hooks (documented, unverified) |
| | MCP (`mcp__*`) | pass (fixture): denied | hooks fire for MCP tools (documented, unverified) |
| | gate internal failure (bad policy/JSON) | pass (fixture) | exit 2, tool not executed |
| | hook launch failure (missing script, timeout) | pass (fixture) / unverified live | fixture models fail-open without `onFailure:"block"`; closed with it; real CLI honouring `onFailure` unverified; `--disallowedTools` is the backstop for non-read tools |
| | exit 0 with unparseable stdout | unverified | fixture assumes no decision, tool proceeds |
| | hooks disabled by settings/policy (`disableAllHooks`, `allowManagedHooksOnly`) | fail-open (unverified live) | hook never runs; host must verify/isolate config (item 8) |
| | bypass args refused | pass (fixture) | |
| | real CLI honours hook deny / exit 2 | unverified | needs live run |
| CLI `--permission-prompt-tool` (MCP) | interception | unverified | not built; would need an ARRC MCP server |
| Agent SDK `canUseTool` | interception | unverified | not built; SDK not a dependency; only called when a prompt would occur, so a hook is still needed |
| Interactive CLI | interception | unsupported | human-driven, ARRC does not mediate |
| Any | auth classification | pass (fixture) | env presence only |
| | subscription detection from init | unverified | apiKeySource value unknown for subscription; `apiKeyHelper`/`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` map to api (fixture) |
| | rate-limit payload parsing | pass (fixture) | live payload unverified |
| | quota remaining / plan tier | unsupported | not exposed |

Acceptance mapping: (1) hook interception proven on fixture, shell/web/subagent/MCP rejected rather than mediated; (2) done, subscription positive-detection partial; (3) done to the extent the signal exists; (4) this document. Overall M0-08 live enforcement remains **unverified**.

## Remaining live verification (not run; consumes quota)

Create `policy.json` (model principal `claude-code`, `fs.read` root = a scratch dir) and a scratch dir with one file, then:

```
npm run claude-probe --silent -- --live --exe C:\path\claude.exe --model haiku --gate C:\path\policy.json
```

Note the existing live prompts use no tools, so also run a manual `claude -p` with the printed `--settings` args and a prompt that reads an in-policy file, an out-of-policy file and runs a shell command, and record: hook fired, deny reason shown, tool not executed, `rateLimits` payload, `apiKeySource` under a subscription login, absence of tool prompts. Open unknowns: exact deny surfacing in stream-json, whether `--settings` hooks merge with or are overridden by managed/project settings, hook behaviour for subagent and MCP calls, whether the exec-form hook (`command` + `args`) is honoured on Windows.

## Sources

- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/permissions
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/authentication
- https://code.claude.com/docs/en/agent-sdk/permissions
- Issue #13; M0-07 spike `0001-claude-control.md`
