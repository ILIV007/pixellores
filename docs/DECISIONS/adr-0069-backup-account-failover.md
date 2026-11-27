# ADR-0069: the backup-account Workers AI failover (ai-policy-v2.3) and the early budget-warning/reserve governance

- Status: Accepted (code + offline tests; every live activation stays
  BLOCKED_LIVE — the secret, the var, and the flag flip are operator rounds)
- Date: 2026-11-22
- Round: v2.3 (workstream 1 of the consolidated build; source tree = main
  `0531b6a`, ai-policy-v2.2 shipped live as PR #25)
- Spec: the failover design document (`pixel-failover-design-2026-11-21.md`,
  in-thread), implemented EXACTLY as designed — same trigger, same port
  shape, same accounting, same kill switch, no R2 anywhere.

## Context

The 2026-11-21 incident chain is closed at its root by v2.2 (the
chat.completion parse fix), but the owner's standing order remains: when the
PRIMARY Cloudflare account's Workers AI budget runs out, the chain must use
the BACKUP account. The app-level budget is the D1 `budgets` row per
`(scope='ai', budget_key=<provider>, bucket_date=<Tehran day>)`, charged per
attempt through `authorizeAiRequestAttempt` and capped by
`AI_DAILY_REQUEST_ATTEMPT_CAPS['workers-ai'] = 120`. A denial surfaces as the
TERMINAL `budget_denied` (handler maps it to
`editorial_budget_exhausted`) — once the day row hits the cap, no same-day
retry can succeed, so a failover signal detected at the handler (or by
polling) is structurally too late: the decision MUST be made at the denial
branch inside the draft service, before the outcome is produced.

The backup account is verified empty (no worker, no zones, no D1, only
orphaned empty KV namespaces). R2 is NOT enabled there and is NEVER to be
used (owner decision 2026-11-21).

## Decision

1. **A distinct provider key `workers-ai-backup` — not a wrapper, not a
   second worker.** The budget store authorizes per attempt keyed by the
   provider string BEFORE any port call; a wrapper under `'workers-ai'`
   could not separate primary from backup charges in one bucket row. A
   second worker deployment on the backup account is rejected (split-brain
   D1 state, the single-Telegram-webhook constraint, a full second
   environment for what is one inference call). AI Gateway is rejected
   (managed resource + second billing path + a header contract for no
   benefit over direct REST). The distinct key makes per-account accounting
   work with the EXISTING store unchanged: no migration, no DDL — the
   provider key is just a new row per Tehran day.

2. **The REST port (`workers-ai-rest-adapter.ts`).** The backup path is
   `POST https://api.cloudflare.com/client/v4/accounts/{BACKUP_CF_ACCOUNT_ID}/ai/run/{model}`
   with `Authorization: Bearer {token}` and the SAME JSON inputs the binding
   takes (`{ messages, max_tokens }`). The token travels ONLY in the
   Authorization header — never in a URL, log, error, or outcome. The REST
   envelope `{ result, success, errors, messages }` is unwrapped and the
   EXISTING `interpretRunResult` chat.completion extraction is reused, so
   the v2.2 parse fix applies to the backup path unchanged. The adapter
   follows the Gemini adapter's established pattern: bounded `fetch` with an
   `AbortController` deadline race covering headers AND body, bounded body
   read, strict HTTPS to ONE fixed origin (the account id and model id are
   the only caller-controlled path segments, both strictly validated),
   `redirect: 'manual'` (corrected 2026-11-27 from `'error'`: workerd
   rejects `'error'` with a synchronous TypeError — the same root cause
   as the Gemini transport failure, ADR-0070 §1; the refusal intent is
   preserved, the 3xx maps to `transient`, never followed), and the
   stable outcome mapping (429 → `quota_denied`
   with Retry-After, 401/403 → `auth_failed`, 404 → `model_unavailable`,
   other non-200 → `transient`, 200 with `success: false` → `transient`).

3. **The trigger is the DENIED app-budget authorization (and, secondary, a
   provider `quota_denied`) — NEVER an open circuit breaker.** Breaker-open
   means the provider PATH is failing; failing over on it would burn the
   backup budget on the same defect (the exact v2.2 lesson: a parse bug made
   every good answer look transient, which would have opened the breaker and
   then burned the backup). An open PRIMARY breaker returns typed
   `circuit_open` with zero failover and zero charges. An open BACKUP
   breaker skips only the backup candidates; the ladder continues. The
   existing per-provider skip machinery (`sharedQuotaProviders`,
   `authFailedProviders`) routes the ladder correctly once the backup is a
   distinct key — a primary denial skips the remaining primary candidates
   and falls through to the backup's own bucket.

4. **Per-account circuit breakers.** The v2.2 single settings key
   `ai.circuit_breaker` is replaced by per-provider keys
   `ai.circuit_breaker.{provider}` (same threshold 5, same 15-minute
   cooldown). A failure on one account is evidence about THAT account's path
   only; the old row is deliberately orphaned (an absent row parses CLOSED —
   the state carries no durable meaning worth migrating). Breaker
   bookkeeping moves WITH the candidate: `noteBreakerFailure/Success` now
   take the candidate's provider.

5. **Failover is gated by the operator kill switch `AI_FAILOVER_ENABLED`
   (default OFF) AND the wired port.** The backup REST port is built ONLY
   when the flag is on AND the `BACKUP_WORKERS_AI_API_TOKEN` secret AND the
   `BACKUP_CF_ACCOUNT_ID` var are all present (fail-closed conjunction at
   the wiring sites, enforced again inside the shared ladder builder —
   layered defense). The account id is non-secret operator configuration,
   strictly format-validated (32 lowercase hex) by `parseAiConfig` when
   present; the token is a secret with Workers AI Write permission, stored
   on the PRIMARY worker. NO credential exists in code, fixtures, docs, or
   tests. Flipping the flag off kills failover without a redeploy.

6. **Switch-back is automatic.** The budget day is the Tehran calendar date;
   at midnight `tehranBudgetDay` changes, the next primary authorization
   takes the `INSERT..SELECT` new-day branch, and the static ladder walks
   from the top again. There is no switch state to reset and nothing to
   flap: every invocation independently authorizes per attempt. Charge-on-
   success refunds can reopen a primary unit late in the day; that is the
   refund mechanism working as designed (each reopened unit is a real
   primary attempt, not a loop).

7. **Early budget-warning/reserve governance (gap b).** The autonomous
   chain (drafting, event-relation, inbound rewrite) authorizes against the
   EFFECTIVE cap (`AI_DAILY_REQUEST_ATTEMPT_CAPS[provider] −
AI_BUDGET_PRESSURE_RESERVE_UNITS`); the reserve holds back the tail of
   each account's day as bounded headroom against accounting drift (the
   ~3-unit remainder observed on 2026-11-21) and one-shot operator probes.
   A denial INSIDE the reserve window is classified through a best-effort
   readback (`classifyAiBudgetDenial`) and defers typed `budget_pressure` —
   RETRYABLE — instead of the terminal hard denial; a denial at the hard cap
   (or any ambiguous/failed readback) stays the terminal `budget_denied` —
   ambiguity never softens a denial. Crossing
   `AI_BUDGET_PRESSURE_WARNING_REQUESTS` logs the sanitized
   `ai.budget.pressure_warning` event once per crossing (counts only;
   visibility, never enforcement). The hard caps themselves are unchanged:
   a non-reserving caller can still spend to 120.

8. **The shared ladder builder (`ai-ladder.ts`).** One construction site for
   the versioned allowlist walk (Workers AI primary → alternate → BACKUP
   primary → BACKUP alternate → conditional Gemini) so the three
   authorizing services cannot diverge on order or per-provider gating. The
   builder is pure and synchronous (no D1, no clock, no network); run-time
   skip state stays in the services. Event-relation keeps its R1.17
   contract exactly: its Gemini gate set predates the `AI_GEMINI_ENABLED`
   operator flag, and a denial on a pair still defers that pair (the NEXT
   pair walks past the skipped bucket and can reach the backup — documented
   pair-lag, not invocation-wide failover).

## Alternatives rejected

- **Second worker deployment on the backup account** — splits durable state
  across two D1s (violates "D1 is the source of truth"), needs cross-account
  queue handoff the system does not support, and provisions a full second
  environment for one inference call.
- **A routing wrapper under one `'workers-ai'` key** — cannot separate
  per-account charges in one bucket row; defeats the purpose.
- **AI Gateway** — managed gateway resource, second billing path, header
  contract; direct REST keeps each account's free allowance separate.
- **R2 anywhere** — forbidden by owner decision (2026-11-21). This design
  uses no R2, no KV, no queues on the backup account: NOTHING is deployed
  there except the token.

## Consequences

- `ai-policy-v2.3`: `AiProvider` gains `'workers-ai-backup'`; the allowlist
  gains the same two model ids under the new provider; the caps map gains
  `'workers-ai-backup': 120`; the eligibility map gains the
  `binding_gated` entry (the wired port IS the access proof).
- Both wiring sites (`engine-env.ts`, `telegram-webhook.ts`) build the
  backup port under the same fail-closed conjunction; the services share
  the ports map, so drafting, event-relation, and the inbound rewriter all
  inherit the backup path.
- `AiDeferredReason` gains `budget_pressure` (retryable);
  `AiAttemptRecord.outcome` gains `skipped_circuit_open` (ledger-only).
- **Honest unproven surfaces (live):** the REST latency of the backup path
  is unproven — the 60 s wall is assumed sufficient (binding ~12 s + one
  HTTPS round-trip); a live probe with a real draft prompt is a required
  implementation step before the wall is finalized. The first live REST
  call against the backup account is a proof step, not an assumption. The
  effective backup capacity is `min(app cap, provider neuron allowance)` —
  the two meters are independent.
- **Operator steps (once, dashboard only):** create the backup token
  (Workers AI Write), set `BACKUP_WORKERS_AI_API_TOKEN` +
  `BACKUP_CF_ACCOUNT_ID` on the primary worker, run the single-job test,
  then flip `AI_FAILOVER_ENABLED=true`. Token rotation: new token → replace
  the secret → revoke the old. Blast radius of a leaked backup token is
  Workers AI inference on the backup account only.

## Verification (offline)

- Unit: the dedicated failover suite (`tests/unit/ai-failover.test.ts`,
  23 tests) over a per-provider stateful fake enforcing the store's
  guarded-cap semantics — primary denied → backup authorized and called;
  backup hard-denied → terminal `budget_denied`; reserve-window denial →
  retryable `budget_pressure` (hard dominates in mixed states); Tehran
  midnight rollover → primary authorized again; breaker open on primary →
  `circuit_open` with ZERO failover; breaker open on backup → only backup
  candidates skip; refunds never cross provider keys; per-account breaker
  counters; kill-switch-off keeps the ladder v2.2-exact; missing binding →
  the ladder starts at the backup; the 96-crossing warning fires once.
  Plus the REST adapter suite (envelope unwrap, token hygiene, status
  mapping, deadline race) and the shared builder gates.
- REAL D1 (`tests/integration/ai-failover-budget.test.ts`, registered in
  `test:db`): per-account rows without migration, per-account caps,
  refund isolation floored at 0, the reserve boundary under the effective
  cap, the midnight rollover, and the per-account breaker keys.
- Full gate: `npm run check` + `npm run test:db` on the delivery tree.
