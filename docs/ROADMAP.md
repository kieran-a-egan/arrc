# ARRC roadmap

Primary development and M0/M1 acceptance: **native Windows with PowerShell**. GitHub is the product backlog; ARRC's internal DAG will manage ephemeral execution tasks, retries and experiments.

| Stage | Tracker | Exit gate |
| --- | --- | --- |
| M0 Foundation and feasibility | [#1](https://github.com/kieran-a-egan/arrc/issues/1) | Windows toolchain, typed contracts, Jev metadata decisions and controllable installed Claude integration |
| M1 Functional vertical slice | [#2](https://github.com/kieran-a-egan/arrc/issues/2) | Real task to verified diff, denial, cancellation and safe resume |
| M2 Multi-agent orchestration | [#3](https://github.com/kieran-a-egan/arrc/issues/3) | Concurrency with task ownership, dependencies and shared quota |
| M3 Reliability and security | [#4](https://github.com/kieran-a-egan/arrc/issues/4) | Local daemon/TUI and validated isolation, fault and platform tests |
| M4 Optimisation and extensibility | [#5](https://github.com/kieran-a-egan/arrc/issues/5) | Extensible providers, remote workers and calibrated optimisation |

## M0: detailed implementation tasks

- [M0-01 — #6 Workspace bootstrap](https://github.com/kieran-a-egan/arrc/issues/6)
- [M0-02 — #7 Windows doctor](https://github.com/kieran-a-egan/arrc/issues/7)
- [M0-03 — #8 Typed contracts](https://github.com/kieran-a-egan/arrc/issues/8)
- [M0-04 — #9 SQLite persistence](https://github.com/kieran-a-egan/arrc/issues/9)
- [M0-05 — #10 Policy kernel](https://github.com/kieran-a-egan/arrc/issues/10)
- [M0-06 — #11 Jev integration](https://github.com/kieran-a-egan/arrc/issues/11)
- [M0-07 — #12 Native Windows Claude spike](https://github.com/kieran-a-egan/arrc/issues/12)
- [M0-08 — #13 Claude permissions and subscription quotas](https://github.com/kieran-a-egan/arrc/issues/13)
- [M0-09 — #14 Conformance/CI](https://github.com/kieran-a-egan/arrc/issues/14)

## M1: detailed implementation tasks

- [M1-01 — #15 Intake/routing](https://github.com/kieran-a-egan/arrc/issues/15)
- [M1-02 — #16 Typed DAG](https://github.com/kieran-a-egan/arrc/issues/16)
- [M1-03 — #17 Native agent loop](https://github.com/kieran-a-egan/arrc/issues/17)
- [M1-04 — #18 Claude executor](https://github.com/kieran-a-egan/arrc/issues/18)
- [M1-05 — #19 Windows process supervision](https://github.com/kieran-a-egan/arrc/issues/19)
- [M1-06 — #20 Git worktrees/ownership](https://github.com/kieran-a-egan/arrc/issues/20)
- [M1-07 — #21 Approval broker](https://github.com/kieran-a-egan/arrc/issues/21)
- [M1-08 — #22 Checkpoint/resume](https://github.com/kieran-a-egan/arrc/issues/22)
- [M1-09 — #23 Independent review](https://github.com/kieran-a-egan/arrc/issues/23)
- [M1-10 — #24 Native Windows CLI](https://github.com/kieran-a-egan/arrc/issues/24)
- [M1-11 — #25 End-to-end acceptance](https://github.com/kieran-a-egan/arrc/issues/25)

## M2–M4: epics, not implementation-ready tasks

M2: [#26](https://github.com/kieran-a-egan/arrc/issues/26)–[#31](https://github.com/kieran-a-egan/arrc/issues/31) (agent roles, concurrency, quota ledger, handoffs, ownership and recovery).

M3: [#32](https://github.com/kieran-a-egan/arrc/issues/32)–[#38](https://github.com/kieran-a-egan/arrc/issues/38) (daemon, TUI, isolation, plugins, verification, incident recovery and packaging).

M4: [#39](https://github.com/kieran-a-egan/arrc/issues/39)–[#44](https://github.com/kieran-a-egan/arrc/issues/44) (providers, remote workers, speculation, Jev calibration, cross-run coordination and plugin SDK).

## Ready-for-implementation definition

A Ready issue has explicit versioned dependencies, target environment, verifiable acceptance criteria, recognised policy and side effects, and evidence requirements. No issue is accepted merely because an agent reports success.

## Native GitHub Milestones/Project

The connected GitHub integration creates issues/files but does not expose native Milestone/Project creation. The five stage trackers are therefore issues, not true GitHub Milestones. Use the [Windows GitHub configuration script](../scripts/configure-github.ps1) after authenticating gh to create milestones, apply them to the already-created issues and optionally organise a Project.
