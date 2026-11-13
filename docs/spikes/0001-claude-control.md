# Spike 0001: controlling installed Claude Code on native Windows (M0-07, #12)

## Purpose and scope

Decide how ARRC launches and observes the user's installed Claude Code on native Windows.
Transport exercised: **CLI only** (`claude -p ... --output-format stream-json --verbose`, `shell:false`).
The Agent SDK is documented from official docs and was **not exercised**; no SDK dependency was added.

Auth: relies solely on the installed CLI's own login. The probe does not read tokens or credential files, emulates no auth and uses no login workaround.

Policy assumption (applies to CLI and SDK alike): ARRC drives the user's own locally installed and logged-in CLI, for that user only. Any product or distributed use must use API-key billing. No token reading, no login emulation.

## How to run

```
npm run claude-probe -- --json                  # locate + fingerprint, no session, no cost
npm run claude-probe --silent -- --live --exe C:\path\claude.exe --model haiku   # one gated live run (3 runs over 2 sessions: first + resume, then a separate cancel run)
```

Locate precedence: `--exe` > `ARRC_CLAUDE_EXE` (both trimmed, one pair of surrounding double quotes stripped) > PATH `.exe` > `~/.local/bin/claude.exe` > any other PATH hit (a shim, reported as `blocked`). Path must be absolute; on Windows only `.exe` is launched (`.cmd/.bat/.ps1` => `blocked`, never executed).

## SDK vs CLI

| Area | CLI (`claude -p`) | SDK (`@anthropic-ai/claude-agent-sdk`, 0.3.323 at time of writing) |
|---|---|---|
| Streaming | `--output-format stream-json --verbose` emits NDJSON: `system`(init), `assistant`, `user`(tool_result), `result`; `stream_event` only with `--include-partial-messages`. **Exercised (CLI)** | Async iterator of typed messages; partial messages via `includePartialMessages`. Documented, not exercised (SDK) |
| Cancellation | Parent kills process. Node `kill()` on Windows is forceful and spares descendants, so we use `taskkill /pid <pid> /T /F`. **Exercised (CLI)**; Windows tree kill is tested against a fake whose grandchild is `detached` (outside the job object) and fails without taskkill. POSIX tree kill is unverified/unsupported here: only the direct child gets SIGTERM. Graceful SIGINT from a Node parent: unsupported | `abortController`, `query.interrupt()`, `close()`. Documented, not exercised (SDK) |
| Resume | `--resume <session-id>`. **Exercised (CLI)** | `resume`, `forkSession`. Documented, not exercised (SDK) |
| Model selection | `--model <alias\|id>`. **Exercised (CLI)** | `model` option; `setModel()` only with streaming input. Documented, not exercised (SDK) |
| Tool observability | `tool_use` blocks in `assistant` events, `tool_result` in `user` events. Verified against fake stream; **not observed live** (live prompts used no tools) | Same messages plus hooks `PreToolUse`/`PostToolUse` and `canUseTool` (called only when a permission prompt would occur). Documented, not exercised (SDK) |
| Permissions | Since CLI v2.1.302, `-p` defaults to manual mode: tools needing approval are denied unless allowed via flags/settings. Not exercised | `permissionMode`, `canUseTool`, allow/deny lists. Documented, not exercised (SDK) |
| Windows quirks | See below | Bundles the native CLI via optional deps; `pathToClaudeCodeExecutable` selects the installed exe; `env` option replaces the whole environment. Documented, not exercised (SDK) |
| Install/auth | Native installer puts `claude.exe` in `~/.local/bin`; uses its own login or env credentials | Same auth sources. Docs restrict offering claude.ai subscription login in third-party products built on the SDK, so product use must use API-key billing |

## Windows quirks and fingerprint notes

- `.cmd/.bat` cannot be spawned without a shell (CVE-2024-27980 makes Node return EINVAL); we never use `shell:true`, so shims are refused.
- Node's `kill()` is always TerminateProcess on Windows; tree kill uses `%SystemRoot%\System32\taskkill.exe /T /F` (falls back to `kill()` if taskkill errors; 2s grace then pipes are destroyed and the run resolves). Quirk: libuv puts non-detached Node children in a kill-on-close job object, so they die with the parent regardless; real `claude.exe` descendants may not be in that job, hence `/T`.
- Guard: the prompt is positional (`-p` is a boolean flag), so `runClaude` refuses prompts whose first non-whitespace character is `-` (reported in `spawnError`, no spawn); a `--` separator is not relied on because CLI support is unverified.
- Limitation: live runs inherit the repo cwd, so project `CLAUDE.md`/settings apply to the probe's sessions.
- `C:\Windows\System32\bash.exe` (WSL launcher) can shadow Git Bash on PATH; Claude Code on Windows wants Git Bash (`CLAUDE_CODE_GIT_BASH_PATH`). On the test machine it is unset and Git is at `C:\Program Files\Git`.
- Self-update leaves `claude.exe.old.<n>` backups in `~/.local/bin`; the probe sets `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` for all runs.
- Fingerprint = absolute path, `--version`, size, mtime (no hash of the ~350 MB binary), existence-only flags for the four `settings*.json` files, presence-only booleans for `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_GIT_BASH_PATH` (these change billing identity). Credential files are never opened or stat-ed.

## Capability table

| Capability | Status |
|---|---|
| locate (explicit absolute exe) | supported (exercised live) |
| launch + stream | supported (exercised live) |
| resume | supported (exercised live, same session id) |
| model selection | supported (exercised live, `haiku` resolved to `claude-haiku-5-5`) |
| cancel | supported, forceful only on Windows (live run: process terminated, `cancelled=true`); graceful interrupt via CLI from Node: unsupported |
| tool observability | supported via `tool_use` blocks; verified on fixture only, unverified live |
| hook events (SDK) | documented, not exercised |
| SDK transport | documented, not exercised |
| shim (`.cmd`) launch | blocked by design |

## Live evidence

Date: 2026-11-13. CLI: `2.1.323 (Claude Code)`, win32 10.0.26200 x64.
Command: `npm run claude-probe --silent -- --live --exe C:\Users\Kieran\.local\bin\claude.exe --model haiku`

| Run | Events | Session | Model | Result | Exit |
|---|---|---|---|---|---|
| first | system 3, assistant 1, rate_limit_event 1, result 1 | 929f9a81-... | claude-haiku-5-5 | success, isError=false | 0 |
| resume | system 5, assistant 2, rate_limit_event 1, result 1 | same as first | claude-haiku-5-5 | success, isError=false | 0 |
| cancel (abort on first event) | system 2 | 4f87b0f5-... (new) | n/a | none | 1, `cancelled=true`, `timedOut=false` |

`resumedSameSession=true`; no tool uses, no malformed lines, empty stderr. Env flags: all auth-related variables absent (CLI used its own login); `~/.claude/settings.json` present. Assistant text was not captured.

## Sources

- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/agent-sdk/streaming-output
- https://code.claude.com/docs/en/setup
- https://code.claude.com/docs/en/troubleshoot-install
- https://code.claude.com/docs/en/authentication
- https://nodejs.org/api/child_process.html
