# ARRC

**Agent Runtime & Reasoning Coordinator**

ARRC is a local-first, Windows-native-first coding-agent orchestration engine. It combines deterministic scheduling and policy enforcement with a configurable System One decision pipeline, native and external coding agents, and independent verification.

> Status: **design / M0 foundation**. The repository is being bootstrapped; no functional runtime is claimed yet.

## Principles

- **Deterministic authority:** a policy-governed orchestrator owns execution, scheduling, budgets and approval gates.
- **Composable System One:** Jev is the initial learned decision provider; policy and calibrated uncertainty constrain its recommendations. Only metadata is sent to hosted System One.
- **Hybrid executors:** first-class native agent runtime and Claude Code adapter, with capability negotiation and refusal when mandatory guarantees cannot be met.
- **Windows native:** PowerShell, Git for Windows and Node.js/npm. WSL and Docker are optional, never prerequisites for M0/M1.
- **Security without assumptions:** Git worktrees isolate code changes, not hostile execution. External effects require enforceable capabilities and approvals.
- **Evidence-based completion:** passing assertions and reviewer evidence, not an agent's self-report, determine acceptance.
- **Local-only telemetry:** execution events and diagnostics stay on the host; approved inference traffic is distinct.

## Roadmap

| Stage | Goal |
| --- | --- |
| M0 | Contracts, Windows environment doctor, Jev and Claude Code feasibility |
| M1 | One request to independently verified code change, with recovery and approval gates |
| M2 | Concurrent multi-agent orchestration and quota-aware scheduling |
| M3 | Security and reliability hardening, daemon, TUI, cross-platform verification |
| M4 | More providers, remote workers, speculative execution and adaptive optimisation |

See [roadmap](docs/ROADMAP.md), [architecture](docs/ARCHITECTURE.md), and [GitHub issue backlog](https://github.com/kieran-a-egan/arrc/issues).

## Intended developer experience

```powershell
# Illustrative commands; not implemented yet
arrc doctor
arrc run "Fix the failing validation test"
arrc status
arrc approve
arrc resume
```

## Development environment

Primary development and acceptance platform: **Windows, native PowerShell**. Use the root npm scripts (`npm ci`, `npm run build`, `npm run typecheck`, `npm test`); the pinned toolchain is described in [docs/DEVELOPMENT-WINDOWS.md](docs/DEVELOPMENT-WINDOWS.md). `npm run doctor` validates the toolchain rather than inferring it from the host.

## Name

ARRC = **Agent Runtime & Reasoning Coordinator**. Pronounced "ark". External trademarks, domains and public package-name availability are not yet cleared.

## Scope and governance

The long-term architecture was informed by 100 design decisions. This README is an entry point, not a complete implementation specification. M0/M1 issues should define concrete acceptance tests, and later milestones remain provisional epics until earlier contracts are proven.
