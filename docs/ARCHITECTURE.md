# ARRC architecture — preliminary design

ARRC (**Agent Runtime & Reasoning Coordinator**) is a local-first, Windows-native-first coding-agent orchestrator. The user-facing lead agent provides strategy; a deterministic orchestrator owns scheduling, permissions, budgets, task ownership and acceptance. **System One (initially Jev) is an adviser, never an execution authority.**

## Architecture

1. CLI/TUI/headless control API: intake and human intervention.
2. Progressive metadata-only evidence extraction and configurable System One decisions.
3. Immutable deterministic policy, risk, budget, approval and capability gates.
4. Versioned typed task DAG: planner proposes; orchestrator schedules and replans.
5. Native TypeScript agent loop and installed Claude Code integration via supported SDK/CLI.
6. Independent test/review/acceptance pipeline; authorised Git delivery.
7. SQLite WAL event store and durable filesystem artefacts/checkpoints.

## Invariants

- Every cross-agent boundary has versioned, runtime-validated contracts for tasks, decisions, executors, events, approvals and evidence.
- Agents and external plugins request capabilities; no model can approve its own privileged operation, exceed budgets, overwrite unowned work or widen immutable security policy.
- Hosted System One receives metadata and derived risk signals only, not raw source or credentials. Events and diagnostics remain local; approved inference calls are separate.
- Invalid, conflicting, unavailable or uncalibrated high-risk System One advice fails closed, rather than silently choosing a weaker policy.
- Worktrees separate changes and preserve ownership, but are **not security sandboxes**.
- External runtimes must expose or enforce required operation permissions; otherwise downgrade only to a genuinely compatible, authorised profile or reject.
- Claude Code uses the user-installed executable and user-controlled authentication through compliant supported integration mechanisms. Detect API versus subscription billing identity; never invent quota balances or enable unapproved API spend.
- Approval grants bind exact operations, actors, targets, digests, policies, expiry and revocation; uncertain external effects require reconciliation before retry.
- Independent verification preserves all failures, reviewer findings, baseline integrity and environment fingerprints. An agent's completion claim is insufficient.
- Replay and recovery reconstruct recorded state without re-executing side effects. Restored runs remain paused until safety reconciliation.
- All tests needed for mandatory guarantees exist before the relevant feature is permitted; later milestones harden, not defer basic safety.

## Native Windows platform contract

Primary M0/M1 environment is native PowerShell on Windows with Node.js/npm, Git for Windows and locally installed coding agents. No mandatory WSL/Docker. Shell-neutral structured process invocation uses explicit executables and arguments, with separate .exe/.cmd/.ps1 handling; test Unicode paths, path escaping, case-insensitive collisions, file locks and descendants on cancellation. A worktree alone cannot satisfy a security sandbox requirement. Optional OS/container isolation tiers are capability-probed and enforced. Local user data should default beneath %LOCALAPPDATA%/ARRC.

## Scope control

The initial technical delivery is a complete vertical slice: request → evidence/Jev → task plan → native or Claude execution → permission enforcement → independent verification → resumable state → inspected diff. Concurrent agent teams, advanced quota coordination, daemon, TUI, full security tiers and remote workers are later milestones.

For exact work and gates, see [the roadmap](ROADMAP.md). For design trade-offs and policy invariants, create versioned ADRs under docs/decisions as implementation proceeds. This document is a design baseline, not a claim that runtime features already exist.
