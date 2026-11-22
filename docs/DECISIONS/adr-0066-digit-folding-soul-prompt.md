# ADR-0066: Digit folding in the fact-guard numbers lens + Soul v1 in the draft prompt

- Status: Accepted (owner decision 2026-11-22 ~07:44 Tehran: digit folding approved)
- Date: 2026-11-22
- Base: main 0531b6a (app 1.47.0, schema 11 — unchanged, no migration)
- Supersedes: ADR-0053's "digits NEVER folded across scripts" clause — numbers
  lens ONLY; and the ADR-0041 prompt contract v1 (`pixel-news-draft-v1` → v2).

## Context

The midnight proof (2026-11-22 00:30–01:17 Tehran) published the first two
posts, but the auto-publish gate approved only 2 of 53 drafts. The read-only
draft review (2026-11-22) found the cause in the fact guard: the numbers lens
compared claim digits VERBATIM against the English evidence excerpt, and the
claims are Persian while the evidence is English — «۳٫۷۹» never matches
«3.79», «۲۵» never matches «25». Every draft carrying a date, price, count
or version went to review; only the two number-free drafts auto-approved.
The gate was picking backwards: the important news stayed held, the vague
news passed.

The same review found the second half of the quality gap: Soul v1 is seeded
in D1 and stamped on publications, but NOTHING reads it — the draft system
prompt (`src/domain/ai/prompt.ts`) never mentions it, and the render never
applies it. The model writes dry agency Persian; the posts have no voice.

## Decision

1. **Digit folding in the NUMBERS lens only**
   (`src/domain/editorial/fact-guard.ts`, `foldDigitsForNumberMatch`):
   Persian digits ۰-۹ and Arabic-Indic digits ٠-٩ fold to Latin 0-9; the
   Arabic decimal separator ٫ folds to '.' and the thousand separator ٬
   folds to ','. The fold applies to the claim token AND the excerpt at
   match time only. The verbatim rule stays for direct text match
   everywhere else (quotation, rumor, negation, witness, the evidence
   guard), and a finding still reports the claim's ORIGINAL digits — a
   truly absent «۳٫۷۹» is still flagged, with the token «۳٫۷۹».
   The fold is a 1:1 code-point map, so a folded token is a substring of
   the folded excerpt exactly when the excerpt carries the same digits in
   any script; it can only REMOVE a false `number_not_observed` finding,
   never invent grounding.

2. **`FACT_GUARD_VERSION` stays 1 — deliberately.** The report schema and
   the reader contract are byte-identical; only the numbers-lens matching
   function changed, and only in the false-positive direction. Bumping the
   version would strand every stored v1 report as `unsupported_version` at
   the auto-gate — and the bridge reads STORED reports only, it never
   re-runs the guard, so no re-evaluation path exists to rebuild them.
   Stored pre-0066 reports keep their old findings.

3. **Prompt v2 — Soul v1 in the draft prompt**
   (`AI_PROMPT_VERSION`: `pixel-news-draft-v1` → `pixel-news-draft-v2`):
   the system prompt now carries the Soul v1 voice rules — clean
   conversational Persian («می‌شه»، «نمی‌تونن»), second-person «تو» to the
   reader, third-person factual body, anti-clickbait (the headline is never
   bigger than the news), no fabricated personal experience, and the
   Iranian angle where relevant. The output schema gains exactly ONE
   `categoryEmoji` (Soul §3: 🔴 🚨 🏆 🎮 🟢 🔵) and ONE `trustLabel`
   (Soul §3: #رسمی #تأییدشده #گزارش‌شده #شایعه #لیک #تکذیب‌شده),
   validated as zod enums in `aiSemanticDraftSchema` (`.strict()` kept).
   The model's choice rides in `document_json` as the ADDITIVE `soulForm`
   field (`schemaVersion` stays 1); the RENDER does not consume it yet —
   the Soul form in the render is a separate fix, as is the
   hardcoded «unverified» line, media, and the footer.

## What this does NOT do (honest scope)

- **It does NOT retroactively unblock the 20 held drafts.** The review's
  claim that they "will be re-evaluated in the next bridge pass" is
  incorrect on this codebase: the bridge evaluates the gate over STORED
  `document_json` only (`evaluateAutoPublishGate` reads the stored
  `factGuard` report) and nothing re-runs `buildFactGuardReport`. The 20
  held drafts keep their stored v1 findings until a human clears them or
  a future re-evaluation path exists. Only drafts built AFTER this change
  get the folded lens.
- No render change, no «unverified»-line change, no media, no footer,
  no Gemini wiring, no migration. `AI_POLICY_VERSION` stays
  `ai-policy-v2.2` — this slice touches the PROMPT version axis only,
  which is independent of the policy/allowlist axis.

## Version-collision note

The in-flight Gemini wiring branch (allowlist/policy) does not touch the
prompt; the in-flight house-footer branch touches the render, not the
prompt; the z.ai WS1 failover re-run does not touch the prompt. If the
z.ai re-run delivers its own ADR, it must take the next free number after
0066 — this ADR already holds 0066. Any in-flight branch that touches
`prompt.ts` must rebase onto prompt v2.

## Tests

- `tests/unit/fact-guard.test.ts`: the old "digits are DIFFERENT
  observations" test is replaced by the ADR-0066 folding tests — Persian
  claim vs Latin evidence (the live «۳٫۷۹»/«3.79» case), symmetric
  Latin-vs-Persian, Arabic-Indic digits, the finding still reporting the
  claim's original digits when truly absent, and verbatim direct-text
  matching unchanged outside the numbers lens (quotation lens).
- `tests/unit/ai-policy.test.ts`: prompt v2 pin, Soul voice-rule pins,
  output-schema enum acceptance (all six emojis, all six labels) and
  rejection (missing / out-of-vocabulary).
- `tests/unit/zod-v4-contract.test.ts`: the provider-output fixture
  carries the new fields; the zero-claims shape test stays valid.
- Fixture updates only (no behavior change) across the fake-provider
  responses in the unit + integration suites and the `semanticDraft`
  fixtures of the mapper/contract suites; `document.soulForm` is pinned
  in `tests/unit/editorial-contracts.test.ts`.
