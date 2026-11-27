# Open decisions — log

All Phase-0 open decisions (OD-001..OD-008) were **closed by Alexios in the
Phase-0 review / correction pass on 2026-10-02**. Entries are preserved below
for history; each records the original context, the decision, and the closing
ADR. New unresolved decisions would be added here with status Open.

| ID     | Title                                                                             | Status   | Decided    | ADR      |
| ------ | --------------------------------------------------------------------------------- | -------- | ---------- | -------- |
| OD-001 | TARGET_CHANNEL: secret or config?                                                 | Closed   | 2026-10-02 | ADR-0009 |
| OD-002 | Zod adoption timing                                                               | Closed   | 2026-10-02 | ADR-0010 |
| OD-003 | Queue handler ack-all semantics                                                   | Closed   | 2026-10-02 | ADR-0011 |
| OD-004 | `/version` endpoint timing                                                        | Closed   | 2026-10-02 | ADR-0012 |
| OD-005 | `nodejs_compat` flag                                                              | Closed   | 2026-10-02 | ADR-0013 |
| OD-006 | Per-secret fail-closed readiness phasing                                          | Closed   | 2026-10-02 | ADR-0014 |
| OD-007 | `degraded` readiness semantics                                                    | Closed   | 2026-10-02 | ADR-0015 |
| OD-008 | Worker name and environment resources                                             | Closed   | 2026-10-02 | ADR-0016 |
| OD-009 | Source-data retention enforcement (`storeRawDays`)                                | **Open** | —          | —        |
| OD-010 | The media rights-EVIDENCE model                                                   | **Open** | —          | —        |
| OD-011 | House footer + no source line in channel posts                                    | Closed   | 2026-11-22 | —        |
| OD-012 | The AI presence slice: booleans in the admin panel, never a config inventory      | Closed   | 2026-11-27 | —        |
| OD-013 | Rewrite block `pending` status (ADR-0070)                                         | Closed   | 2026-11-27 | ADR-0070 |
| OD-014 | Rewrite flag OFF at handler execution                                             | Closed   | 2026-11-27 | ADR-0070 |
| OD-015 | Backfill: drafts created while the rewrite flag was OFF                           | **Open** | —          | ADR-0070 |
| OD-016 | `quota_denied` consumes no rewrite attempt                                        | Closed   | 2026-11-27 | ADR-0070 |
| OD-017 | Rewrite input excludes the source-report excerpt; `soulVersion` is prompt-encoded | Closed   | 2026-11-27 | ADR-0070 |
| OD-018 | Editorial post render, v3 form (msg-16 shape)                                     | Closed   | 2026-11-22 | ADR-0071 |

---

## OD-001 — TARGET_CHANNEL: secret or config? — **CLOSED**

**Context (as opened):** Blueprint §4 lists `TARGET_CHANNEL=@pixellort` under
"Required secrets", but the channel username is publicly observable (it also
appears in the blueprint's own footer HTML) and is not credential material.
The Phase-0 default classified it as non-secret configuration
(`PixelConfig.TARGET_CHANNEL`, phase 2); phase 0 does not consume it.

**Decision (Alexios, 2026-10-02):** TARGET_CHANNEL is **non-secret
configuration**. The public channel username is not credential material.
Keep it outside `PixelSecrets`.

**Implementation:** removed from `FUTURE_SECRET_CATALOG`; documented under
non-secret configuration in `.env.example`. See ADR-0009.

**Owner amendment (Round 1.10.5, 2026-10-27):** the channel was renamed by the
owner to **Pixel lore's** (`@pixellores`, https://t.me/pixellores). The
"as opened" quote above is preserved verbatim as history; the current
intended value is `TARGET_CHANNEL=@pixellores` (still non-secret — ADR-0009
classification unchanged).

---

## OD-002 — Zod adoption timing — **CLOSED**

**Context (as opened):** Blueprint §12 mandates Zod parsing for AI provider
outputs. The Phase-0 configuration validator is deliberately dependency-free
(ADR-0003); phase 0 adds no AI SDKs and no schema library.

**Decision (Alexios, 2026-10-02):** Introduce Zod in **Phase 3**, when queue
envelopes and durable job payload contracts are implemented. Reuse it later
for AI structured outputs in Phase 6. The current lightweight configuration
validator may remain dependency-free.

**Implementation:** recorded for phases 3 and 6 in `docs/ROADMAP.md`. See
ADR-0010.

---

## OD-003 — Queue handler ack-all semantics — **CLOSED**

**Context (as opened):** The Phase-0 queue handler acknowledges every message
to prevent unbounded redelivery of a skeleton consumer. No queue exists in
Phase 0; the job framework phase (roadmap phase 3) was expected to replace
this.

**Decision (Alexios, 2026-10-02):** Ack-all is **approved only for the
non-deployed Phase 0 skeleton**. It must be replaced before any real queue
consumer is bound or deployed. **No intermediate deployment with ack-all
behavior is allowed.**

**Implementation:** constraint recorded in the queue entrypoint docs and
`docs/ROADMAP.md` phase 3. See ADR-0011 (amends ADR-0007).

---

## OD-004 — `/version` endpoint timing — **CLOSED**

**Context (as opened):** Blueprint §5 specifies `GET /version` (version,
build commit, schema version). Build-commit injection implies CI changes;
the Phase-0 default deferred the endpoint to phase 2.

**Decision (Alexios, 2026-10-02):** Implement in **Phase 1**. It should
return safe build metadata: application version, commit identifier, schema
version, and deployment environment. Use development-safe defaults locally;
CI/deployment metadata injection will be finalized with the deployment
workflow.

**Implementation:** `docs/ROADMAP.md` moved `GET /version` to phase 1. See
ADR-0012.

---

## OD-005 — `nodejs_compat` compatibility flag — **CLOSED**

**Context (as opened):** Phase 0 uses only Web-standard APIs; no Node-only
APIs. Blueprint principles require avoiding Node-only APIs unless supported
and necessary.

**Decision (Alexios, 2026-10-02):** **Do not enable it now.** Only introduce
it later when an approved dependency has a demonstrated requirement,
accompanied by an ADR.

**Implementation:** `wrangler.jsonc` has no compatibility flags; gate
recorded. See ADR-0013.

---

## OD-006 — Per-secret fail-closed readiness phasing — **CLOSED**

**Context (as opened):** Blueprint §1.10 requires fail-closed readiness
("missing secrets make readiness fail"). Phase 0 binds no secrets and must
run without credentials; validating all blueprint secrets now would make
every Phase-0 deployment permanently `not_ready`. ADR-0008 proposed
phase-scoped gating and asked for confirmation.

**Decision (Alexios, 2026-10-02):** **Phase-scoped fail-closed readiness is
approved.** A credential or binding becomes required when the feature
consuming it is introduced.

**Implementation:** `FUTURE_SECRET_CATALOG` remains the typed per-phase gate
source. See ADR-0014 (confirms ADR-0008).

---

## OD-007 — `degraded` readiness semantics — **CLOSED**

**Context (as opened):** Blueprint §5 allows `ready/degraded/not_ready`.
Phase 0 has no subsystems that can degrade, so only `ready`/`not_ready` are
emitted; the definitions for `degraded` were needed before phase 2 checks
land.

**Decision (Alexios, 2026-10-02):**

- `ready`: all required core dependencies for the deployed phase are
  functional.
- `degraded`: core publishing control remains safe and functional, but a
  non-critical source, optional provider, fallback provider, or optional
  media subsystem is unavailable.
- `not_ready`: required configuration is missing or a core dependency
  required for safe operation is unavailable.

Core dependencies in later phases include required Telegram authentication,
D1, and any queue path required by enabled publishing workflows.

**Implementation:** recorded as the contract for future readiness checks.
See ADR-0015.

---

## OD-008 — Worker name and queue/environment resource names — **CLOSED**

**Context (as opened):** wrangler.jsonc uses `name: "pixel"`; blueprint names
queues `pixel-jobs`/`pixel-dlq`. Actual resource names may need environment
prefixes (preview vs production).

**Decision (Alexios, 2026-10-02):** Separate preview and production
resources. Planned names — Production Worker: `pixel`; Preview Worker:
`pixel-preview`. Production resources: `pixel-db-production`,
`pixel-cache-production`, `pixel-jobs-production`, `pixel-dlq-production`,
`pixel-media-production`. Preview resources: `pixel-db-preview`,
`pixel-cache-preview`, `pixel-jobs-preview`, `pixel-dlq-preview`,
`pixel-media-preview`. Do not create these resources during the correction
pass.

**Implementation:** `wrangler.jsonc` placeholders record the planned names;
no resources were created. See ADR-0016.

---

## OD-009 — Source-data retention enforcement (`storeRawDays = 90`) — **OPEN**

**Context (as opened, R1.22 autopilot tick, 2026-11-06, code @ 2dfba5a,
v1.17.0/schema 6):** the blueprint registry's `globalPolicies.storeRawDays
= 90` is validated by the runtime registry schema
(`src/domain/source/source-registry.ts`) but has NO enforcement path in
product code: no durable job and no DELETE/purge statement touches
`source_items` or `raw_json` (verified by search this round; the "cleanup"
mentions in `prepare-draft-handler.ts` are attempt-scoped in-memory
union-row cleanup, unrelated to retention). `docs/ROADMAP.md` Phase 5 is
honestly marked PARTIAL and claims no retention enforcement, so this is an
OPEN product decision, not a false claim to correct. The Free-plan resource
ledger records storage arrival/retention as UNMEASURED (risk R-STORAGE);
the D1 Free cap is 500 MB per database.

**Why it is not implemented unilaterally:** auto-deleting stored provenance
data is a product/security decision. Raw payloads back the honest
verification chains (evidence provenance, editorial snapshot verification,
exact-content reuse), and a wrong purge silently destroys reproducibility.

**Interactions every option must respect (verified against schema
@ 2dfba5a):**

1. `UNIQUE(source_id, external_id)` and `UNIQUE(source_id, canonical_url)`
   are the ITEM-level dedup boundary — deleting whole rows removes the
   dedup memory: a re-fetched old item re-enters as NEW (re-derived, new
   editorial-draft path). The story-level `story_fingerprints`
   `PRIMARY KEY(kind, value)` remains as the guard, conditional on
   fingerprint coverage.
2. `evidence.source_item_id` is a NOT NULL FK and each evidence row stores
   its own excerpt — purging raw-payload COLUMNS does not destroy existing
   evidence provenance; deleting ROWS needs an explicit FK policy decision.
3. Editorial exact-reuse / snapshot verification relies on stored item
   snapshot identity (`content_hash` / snapshot hashes) — whole-row
   deletion ends future re-verification of old drafts (historical
   auditability loss).
4. Any enforcement must be a DURABLE job with the standard fail-closed gate
   pattern (independent flag, default OFF), budget accounting, bounded
   batches and its own real-path test suite — never an ad-hoc cron DELETE.

**Options (for the owner):**

- **A — purge `raw_json` only** for rows older than `storeRawDays` (rows,
  normalized fields, `content_hash` and URLs retained): preserves dedup
  memory, the evidence FK and the audit trail; loses only the bulk raw
  provider payload, which is the dominant storage component. LEAST
  destructive.
- **B — delete whole rows** older than `storeRawDays`: strongest storage
  relief; breaks item-level dedup memory (re-ingestion risk), needs an
  explicit evidence-FK policy and an accepted historical-auditability loss.
- **C — defer enforcement, measure first**: per the ledger, arrival/
  retention actuals are UNMEASURED and 14 sources with bounded per-item
  caps may stay far under the 500 MB Free cap for a long time; retention
  may be unnecessary in the near term.
- **D — stop storing `raw_json` (or shrink it) at ingestion time**: a
  pipeline/schema change that affects the reproducibility of the
  normalization itself; NOT a retention decision and wider-reaching than
  the others.

**Recommendation recorded for the owner:** Option A if/when enforcement is
wanted, or Option C until a storage measurement exists. Any implementation
is a separate authorized round (durable job + independent fail-closed gate
default OFF + real-path tests); NO activation without an explicit owner
decision, consistent with every other gate in the project.

**Decision:** none yet — **Open**. No ADR filed; this entry records the
options only.

## OD-010 — The media rights-EVIDENCE model (scope / expiry / attribution) — **OPEN**

**Opened:** the a279e13 review round (1.35.0). **Status:** Open — owner
decision required BEFORE any live media publication.

**Context.** The independent review of a279e13 (item 3) re-confirmed: the
officialness of a source (`official_api` origin, or official/verified
source metadata) proves neither a republication license, nor its
scope/destination, nor an expiry, nor attribution compliance. The code now
holds the fail-closed posture end-to-end: `rightsStateFor` feeds ONLY the
mrp1 staging decision (an allow was always strictly scoped
`r2_temporary_only` — fetch + stage into the 72h temporary store, never a
publish grant), and the durable echo of every machine-staged asset is
`unknown` — the publication allowlist (PUBLICATION_MEDIA_RIGHTS_V1:
official / licensed / attribution_required) and the reuse predicate both
refuse it. The machine INVENTS no permission: an affirmative status can
only be recorded by an explicit, evidence-backed owner action (no such
write surface exists yet — deliberately).

**The consequence (honest, by design).** Until the owner records an
affirmative status for a specific asset, NOTHING the machine staged can be
published or reused: the scheduler's send-time/evidence-time rights gate
dead-letters typed (`media_rights_not_publishable`) and the upload path
re-stages instead of reusing. The reuse economy (zero-fetch replays)
applies ONLY to evidence-cleared rows.

**Decision required from the owner (before any live activation):**

1. The evidence model: WHICH records establish `official` / `licensed` /
   `attribution_required` for a specific asset (license text, written
   permission, platform ToS analysis, attribution obligations), and WHERE
   the evidence is stored (schema 6 is frozen — likely a new migration).
2. The scope discipline: per-destination? per-campaign? time-bounded
   (expiry) or perpetual?
3. The attribution workflow: which statuses demand an attribution line,
   and how it is rendered into the caption envelope.
4. The write surface: who records affirmative statuses (owner-only? an
   admin command?), with what audit trail.
5. Whether the upload path's own group send (currently BLOCKED_LIVE with
   no production caller) must consume the same evidence model before any
   live activation — recommended: yes.

**Recommendation recorded for the owner:** keep the fail-closed default
(`unknown` refuses everything) until 1–4 exist; do NOT widen the
allowlist as a shortcut; do NOT map provenance to clearance again.

**Decision:** none yet — **Open**. No ADR filed; this entry records the
required decision only.

---

## OD-011 — House footer + no source line in channel posts — **CLOSED**

**Decided:** owner order, 2026-11-22 ~07:37 («فوتر باید مثل بقییه چنل هامون باشه، منبع هم نمیخواد!»).

**Decision:** every published channel post ends with the house footer — the
single blockquote line `> 👾 @pixellores` — and carries NO source line at
all (no source text, no source link, in any rendering path). This SUPERSEDES
the old rule "source links only for very official/important news" and the
blueprint's "optional source line" (PIXEL_PERSONA_PROMPTS_v1.md); the
blueprint itself is left untouched per AGENTS.md §1.

**Implementation:** `renderEditorialPostText`
(`src/domain/admin-post/editorial-post-render.ts`) is the single choke point
for the editorial path — scheduler, auto-gate, correction render (footer
preserved via entity shift), and admin preview all flow through it — so the
change lands there only: the source section is no longer composed and the
footer is appended as a trailing `blockquote` entity over `👾 @pixellores`
(the same wire form as the inbound flow's `<blockquote>` footer). The
inbound flow already rendered exactly this footer and no source line. Source
data is NOT deleted from D1: the document's `sourceReport` stays stored for
provenance (and its shape is still validated) — it is simply never rendered.
No ADR: no architecture changed, only rendered content, by explicit owner
order.

---

## OD-012 — The AI presence slice: booleans in the admin panel, never a config inventory — **RECORDED (implemented)**

**Question.** The owner wants to see THROUGH THE BOT whether the AI secrets
are populated (Workers AI binding, `GEMINI_API_KEY`, the `AI_GEMINI_ENABLED`
gate). Where may that surface live, and how much may it reveal?

**Decision recorded (the presence slice, v2.3):** a new VIEWING-only admin
panel screen `/menu ai` (bilingual strings, `panel.show_ai` single-use
user-bound tokens, a Back button — the slice-3 screen grammar extended by
one screen). The three booleans are computed at the EXISTING wiring sites
with the SAME expressions the AI services already use
(`env.AI !== undefined`, `env.GEMINI_API_KEY !== undefined`, and the
validated `AI_GEMINI_ENABLED` flag from `parseAiConfig`) — no new detection
path, no third place that decides what "present" means. They are injected
into the panel service as an optional `aiPresence` record; without it the
screen answers honestly that presence is unavailable in this deployment.

**Explicit boundaries (why this shape):**

1. **Booleans ONLY** — the screen renders present/absent and ON/off.
   Secret values, key material, and any derived fingerprint never enter
   code, logs, tests, or the reply text (repo AGENTS.md §3).
2. **The admin panel ONLY** — the operator's Telegram UI behind the
   fail-closed `ADMIN_PANEL_ENABLED` flag and `dashboard.view`. `/health`
   is untouched ON PURPOSE: health intentionally carries no config
   inventory, and a public readiness surface must never become a
   configuration oracle.
3. **Additive and inert** — no draft/publish/budget/queue code is touched,
   no new flag, no new store read on any other screen's path, no R2. The Gemini ADAPTER is wired as a direct fallback (PR #28, ADR-0067):
   the presence boolean says a key EXISTS, never that Gemini is usable —
   eligibility is partial_free_tier (a free tier exists per official docs;
   the per-project quota stays unverified) and the flag stays OFF until a
   live test flips it.

**Not decided here (deliberately open):** whether the owner later wants a
push notification when presence changes (needs a comparison surface and a
trigger policy — a new decision), or per-account failover presence
(`AI_FAILOVER_ENABLED` + the backup token) on the same screen once the
failover round goes live. The screen's record is shaped so both can be
added as more booleans without a redesign.
=## OD-013 — Rewrite block `pending` status (ADR-0070) — **CLOSED**

**Context:** ADR-0070 names only `rewritten`/`failed` for the rewrite
block. A failed invocation that has NOT yet exhausted the 2-attempt
budget needs its spent count to survive across job generations, or the
next generation would re-spend attempt #1 forever.

**Decision (implementation, 2026-11-27):** the block gains a third
status, `'pending'`, written by `markRewritePendingOnDocument` with the
spent count. The bridge defers ANY status other than `'rewritten'`, so
`pending` behaves exactly like "not yet rewritten" downstream. No ADR
change needed beyond the §4 note.

---

## OD-014 — Rewrite flag OFF at handler execution — **CLOSED**

**Context:** ADR-0070 does not specify what a `rewrite_draft` job does
if `AI_GEMINI_REWRITE_ENABLED` flips OFF between enqueue and
execution.

**Decision (implementation, 2026-11-27):** the job completes with zero
work (success, no engine-retry burn, no provider call). The draft
stays raw and bridgeable while the flag is off. A missed rewrite is
re-enqueued only by a fresh draft creation — the handler never
re-enqueues on its own. The flag is the kill-switch; waiting on it
inside a bounded retry would burn the engine's attempts for nothing.

---

## OD-015 — Backfill: drafts created while the rewrite flag was OFF — **OPEN**

**Context:** drafts created while the flag is OFF (including the 20
held v2 drafts) never get a `rewrite_draft` job — the job is enqueued
only at draft creation, when the flag is on. With the flag ON, the
bridge defers those drafts forever (`deferredRewrite`): they can never
auto-publish, and no code path rewrites them.

**Decision:** none yet — **Open**. The implementation deliberately does
NOT invent a bridge-side enqueue (the bridge must never create jobs —
that would mix the read path with the write path). Options for the
owner: (a) a one-off backfill job that enqueues `rewrite_draft` for
ready drafts with no rewrite block; (b) leave old drafts for the human
path and only new drafts flow through the rewrite; (c) accept that the
20 held drafts stay raw and bridge them with the flag off. Needs the
owner's call before the flag is ever flipped on.

---

## OD-016 — `quota_denied` consumes no rewrite attempt — **CLOSED**

**Context:** ADR-0070 §5 says a quota denial defers "WITHOUT consuming
a retry attempt" but does not pin the mechanism.

**Decision (implementation, 2026-11-27):** the denial consumes no
_service-level_ attempt (no document write, the spent count does not
move). The handler returns a recoverable retry with `retryAfterMs =
msUntilNextTehranMidnight` (the engine's deferral primitive), and the
job's `maxAttempts: 10` still bounds executions across days (2 service
attempts + quota-deferral retries, at most ~1/day). The denial IS
observed in `ai_runs` (one failed `news_rewrite` row).

**Amendment (v2.3 rebase, 2026-11-27):** the same treatment covers
`budget_pressure` (the reserve-window denial, ai-policy-v2.3): the
handler defers it to the next Tehran midnight exactly like
`budget_denied`. Refunds could reopen units sooner, but the engine's
only deferral primitive is the retry delay, and midnight is the safe
boundary for both. The `ai_runs` row records the reason distinctly
(`budget_pressure`, not `budget_denied`).

---

## OD-017 — Rewrite input excludes the source-report excerpt; `soulVersion` is prompt-encoded — **CLOSED**

**Context:** ADR-0070 §3 says the rewrite user message carries the raw
draft; it does not say whether the source-report excerpt rides along,
and §4 stamps a `soulVersion` without saying which version source wins.

**Decision (implementation, 2026-11-27):** the source-report excerpt is
deliberately NOT re-sent — the claims are the rewrite's fact basis, and
re-sending the excerpt would only grow the input past the bound without
adding a fact the rewrite may use. The rewrite block's `soulVersion`
is the version the PROMPT encodes (`v1`), not D1's
`soul.current_version` — a Soul v2 requires a prompt v2 bump, so the
stamp can never claim a Soul the prompt does not carry.

---

## OD-018 — Editorial post render, v3 form (msg-16 shape) — **CLOSED**

**Decided:** owner order, 2026-11-22 ~11:55–12:08 (v2 example msg 15 superseded by the v3 example msg 16, approved overall ~12:06 «همین فرم درکل خوبه!»).

**Decision:** the editorial post render composes the v3 form — bold category-emoji title + Latin game name on its own line (italic, optional inline game-page link), body, real-quote blockquote (attribution on its own line INSIDE the blockquote), ONE dedicated figures block (each figure once, Latin digits only, main figure bold+mono via bold-spanning-the-line), unlabeled verdict, house footer blockquote. No trust label, no ⏺ separator, no unverified line, no «حرف آخر:» label, no source line. Numbers fold to Latin at render time; Latin spans are bidi-isolated. An over-long photo caption trims to 1024 units (photo kept, never a second send); text fallback only when no photo exists.

**Implementation:** `renderEditorialPostText` / `renderEditorialPostCaption` (`src/domain/admin-post/editorial-post-render.ts`) + the ADR-0071 envelope exception (a style may strictly contain inline `code`; equal-range style+code stays rejected per the live msg-16 flattening) + the scheduler caption wiring. The claim `status` is no longer a render contract; the fact-guard report remains the internal gate (auto-gate). Full record: ADR-0071.

**Open follow-ups (not in this change):** (1) prompt v3 + mapper must start writing the structured `figures` / `quote` / `verdict` / `gameName` / `gamePageUrl` fields the render consumes (until then: derived figures, no quote/verdict, alias game name, plain italic name); (2) the bold+mono main figure needs live verification on the first real post after deploy (no dry-run for entity parsing) — fallback is code-only. (The multi-photo album, max 4 source photos in one media group, IS in this change — ADR-0071.)
