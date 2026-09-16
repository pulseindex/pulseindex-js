# `health()` Contract: Design Decision Record

> **Status:** design only. No code change yet.
> Scope: `pulseindex-js` (`@pulseindex/sdk`). Written against engine `4b11c0e`.

---

## 1. The defect

`PulseIndexClient.health()` (`src/client/PulseIndexClient.ts:144`):

```ts
async health(): Promise<boolean> {
  try {
    await this.connection.waitForReady();
    await this.getRecoveryState();
    return true;
  } catch {
    return false;
  }
}
```

It reports `true` whenever the channel connects and one RPC succeeds. It does not
inspect the answer.

After a total snapshot loss the engine enters degraded recovery
(`RecoveryOutcome::EmptyAfterFailure`, engine `docs/ingestion-recovery.md`):

| surface | while degraded |
|---|---|
| `Search` | **`UNAVAILABLE`** |
| `GetRecoveryState` | **allowed**: it is the detection mechanism |
| `GET /ready` | 503 |
| `GET /health` | 200 (process is fine) |

So during a real outage of the search path, `GetRecoveryState` succeeds and
`health()` returns `true`. **A monitor built on this SDK reports healthy while every
search returns `UNAVAILABLE`, and keeps reporting healthy for as long as the
degraded state lasts**, which persists across restarts, because the flag lives in
the snapshot header. This is the failure mode monitoring exists to catch.

`README.md:274` documents the current behaviour honestly ("Channel ready +
`GetRecoveryState`"), so the defect is in the contract, not in the implementation of
the contract.

## 2. The proto is a prerequisite, not adjacent work

The vendored `proto/engine.proto` in this repo stops at field 4:

```proto
message GetRecoveryStateResponse {
  uint64 last_cdc_offset = 1;
  uint64 indexed_count = 2;
  uint32 chunk_count = 3;
  uint64 mutations_since_snapshot = 4;
}
```

The engine has carried `bool needs_full_reindex = 5;` since `7c65c61`. Without that
field the SDK **cannot observe** the degraded state, so `health()` cannot be fixed
independently of the proto sync. Alternatives were considered and rejected:

| alternative | why not |
|---|---|
| Probe by issuing a `Search` and watching for `UNAVAILABLE` | Side-effecting health check; conflates transport failure, auth failure and degradation; costs a real query per probe |
| Read the admin HTTP `/ready` | Changes the library's scope from gRPC client to gRPC+HTTP; port 8081 is deliberately unpublished in production compose |

Sequencing is therefore: **proto sync first (mechanical), then the contract fix**,
as two commits. They are separable in review, not in dependency order.

Low risk: the SDK loads the `.proto` at runtime through `@grpc/proto-loader`
(`src/grpc/loadProto.ts`), so adding a field is a text change with no codegen step.
Adding field 5 is wire-compatible in both directions, an older engine simply omits
it and `defaults: true` yields `false`.

## 3. Proposed contract

> **`health()` is `true` only when the engine can serve the client's reads.**

Concretely: channel ready **and** `GetRecoveryState` succeeds **and**
`needsFullReindex === false`.

- `RecoveryState` gains `needsFullReindex: boolean`, mirroring the proto field. This
  is the only new state, and the proto supports it, no invented conditions.
- `health()` stays `Promise<boolean>`. Callers that need to distinguish *unreachable*
  from *degraded* call `getRecoveryState()`, which now carries the flag.
- Auth staleness (engine `/ready` 503 after the 6 h TTL) is **not** covered: it
  surfaces as `UNAVAILABLE` on every RPC including `GetRecoveryState`, so `health()`
  already returns `false` via the existing catch. No change needed.

## 4. Semver

`@pulseindex/sdk@1.0.0` is published. This changes observable behaviour of a public
method: a caller polling `health()` against a degraded engine sees `true` today and
`false` afterwards. It is a bug fix by intent, but it is a behaviour change by
effect, and a consumer could have built alerting around the current (wrong) answer.
See §6.2.

## 5. Regression test

The existing harness in `tests/Integration.test.ts` already runs a real in-process
`grpc.Server` with a mock `getRecoveryState`. Extend it with a `needsFullReindex`
option and assert:

1. healthy engine (`needsFullReindex: false`) -> `health() === true`
2. degraded engine (`needsFullReindex: true`) -> `health() === false` **and**
   `getRecoveryState()` reports the flag
3. unreachable engine -> `health() === false` (existing behaviour preserved)
4. an engine that omits field 5 entirely (older engine) -> `needsFullReindex ===
   false`, `health() === true`: the wire-compatibility case

Test 2 must fail against the current implementation; if it passes before the fix, it
is not testing the defect.

## 6. Decisions required from the owner

**6.1. Confirm the contract in §3:** `health()` false when degraded. The alternative
is leaving `health()` as a liveness probe and documenting loudly that callers must
check `needsFullReindex` themselves. That keeps compatibility but preserves a
foot-gun whose only victim is whoever is not reading the docs during an incident.

**6.2, Version:** `1.0.1` (patch, restores intended behaviour) or `1.1.0` (minor,
new `RecoveryState` field plus a behaviour change). The new field alone argues for
minor; the behaviour change arguably argues for major under strict semver.

**6.3. Is the `README.md` health table part of this commit or the proto commit?**
It documents both.

## 7. Explicitly out of scope

Agreed with the owner, kept out so a confirmed bug fix is not diluted by optional
improvements:

- **Retry / backoff** in the JS client, acceptable to omit in a raw client library;
  to be *documented* as the caller's responsibility, as separate work.
- **`check:proto` drift guard**: separate work, after this.
- **Geo** (`withinRadius`, `GeoHash`), out of scope permanently per decision D6.
- **`ListEntityIds`**: engine-side nice-to-have, unrelated.
