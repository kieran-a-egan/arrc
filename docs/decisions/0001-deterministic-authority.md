# ADR-0001 — Deterministic authority and verified execution

**Status:** Accepted design principle.

**Context:** ARRC combines learned routing, autonomous agents, user workspaces and tool execution. Model decisions and external runtime permission systems are not inherently authoritative for host effects.

**Decision:** The deterministic orchestrator is the only source of execution authority. System One (Jev initially), planners, leads and external runtimes provide proposals, evidence or requests. The policy kernel, resource governor and operation-specific approval broker validate all effects; actions without verifiable enforcement fail closed.

**Implications:** Versioned typed contracts; local event history; explicit capabilities; distinct Git ownership and OS security isolation; verified billing identity; robust cancellation; independently checked acceptance; side-effect-free replay and reconciled checkpoints.

**Proof gates:** M0-05 (policy), M0-08 (Claude enforceability), M1-07 (approvals) and M1-11 (end-to-end failure tests).
