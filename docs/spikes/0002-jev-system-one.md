# Spike 0002: Jev metadata-only System One integration (M0-06, #11)

## Purpose and scope

Prove the System One (Jev) boundary without any live transport: a metadata-only request, a typed decision with provenance, and fail-closed handling under configured policy. Advice is never authority; enforcement stays in deterministic code (`policy.ts`). Implementation: `packages/core/src/system-one.ts`; the provider (`SystemOneProvider`) is the replaceable boundary, faked in tests.

## How to run

```
npm test
```

No network, no credentials, no external side effects.

## Design

- Request (`SystemOneRequest`): operation, file count, line total, lowercase extensions (max 32; non-matching or surplus ones are dropped and counted in `otherExtensions`) and a `sensitivePaths` flag. No path or source fields; strict schema rejects extras. `category` is a short bounded identifier (`^[a-z][a-z0-9.]{0,63}$`). `requestId`/`taskId` are id-shaped strings, not free text by schema, but they MUST be opaque host-generated ids, never model-authored text. `buildRequest` never copies paths or content.
- Decision (`SystemOneDecision`, amended in place at schema v1; nothing persists it yet): adds `category` and `provenance` (provider, model, modelVersion, requestDigest, evidence). `recommendation` is capped at 200 chars and `evidence` is limited to request metadata field names. `requestDigest` binds a decision to the exact request it answers; it does not authenticate the provider.
- Gate (`loadSystemOneGate`): supported categories, minimum confidence, timeout, and the `{model, modelVersion}` pairs allowed to claim `calibrated: true`. `adviseSystemOne` re-validates the gate on every call.
- `buildRequest` drops unrepresentable extensions but throws on invalid ids/category/operation (programmer error, fail closed). The provider receives a frozen request; digest and baseline are computed before it runs.
- `adviseSystemOne` never throws. Failure reasons, in order: `invalid_request` (request or gate fails validation; provider not called), `unsupported_category` (provider not called), `unavailable`, `timeout`, `invalid_response` (schema, taskId/category/digest mismatch), `unreliable` (low confidence, or calibration claim from an unlisted model), `baseline_conflict` (advice risk below deterministic baseline), `internal_error` (unexpected exception).
- Baseline: `process.spawn` or sensitive paths = high, `fs.write` = medium, `fs.read` = low.

## Capability table

| Capability | Status |
|---|---|
| adapter boundary (`SystemOneProvider`) | supported (fake provider) |
| metadata-only payload | supported (tests inspect payloads) |
| decision provenance | supported |
| fail-closed gates | supported |
| deterministic baseline comparison | supported |
| live Jev transport | blocked: needs explicit authorisation and a key. A public TypeSafe API is documented at https://docs.typesafe.ai/introduction/quickstart; it is unverified, its identity with ARRC's "Jev" is not confirmed, and it was not called. Using it would send metadata to a third party |

## Out of scope

Calibration measurement, per-bucket thresholds, replay, shadow/canary and drift monitoring belong to M4-04 (#42). `calibrated` is a claim by the provider, accepted only for models listed in the gate. The sensitive-path check is a naive basename heuristic.
