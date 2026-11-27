/**
 * Shared AI candidate-ladder builder (ai-policy-v2.3, ADR-0069) — ONE
 * construction site for the versioned allowlist walk so the three
 * authorizing services (drafting, event-relation, inbound rewrite)
 * cannot diverge on provider order or per-provider gating.
 *
 * The ladder order IS the versioned policy (`AI_MODEL_ALLOWLIST_V2`):
 * Workers AI primary → Workers AI alternate → Workers AI BACKUP primary
 * → Workers AI BACKUP alternate → (conditional) Gemini. Each provider's
 * candidacy gate is fixed here:
 * - `workers-ai` — the native binding is present AND its port is wired.
 * - `workers-ai-backup` — the operator failover flag is on AND the
 *   backup REST port is wired (the wiring sites build the port ONLY
 *   when `AI_FAILOVER_ENABLED` is true AND the backup secret/var are
 *   present — fail-closed: absent pieces mean the backup is simply
 *   absent from the ladder, today's behavior exactly).
 * - `gemini` — the operator flag is on, a key is present, the port is
 *   wired, AND the versioned eligibility is verified (default false —
 *   unverified Free tier stays OFF; zero network).
 *
 * Pure and synchronous: no D1, no clock, no network. The services keep
 * their own run-time skip state (shared provider buckets, auth
 * failures, open breakers) — this builder only decides WHICH candidates
 * may ever run, from the caller's static config view.
 */
import { AI_MODEL_ALLOWLIST_V2, type AiModelRecord } from '../../domain/ai/policy';
import type { AiProvider } from '../../domain/ai/types';

/** Static per-provider candidacy gates, mapped from the caller's config. */
export interface AiLadderGates {
  /** Native Workers AI binding present AND its port wired. */
  readonly workersAiPrimaryPresent: boolean;
  /** The validated AI_FAILOVER_ENABLED operator flag (parseAiConfig). */
  readonly failoverEnabled: boolean;
  /** The backup REST port is wired (flag + secret + var at the wiring). */
  readonly backupPortPresent: boolean;
  /** The validated AI_GEMINI_ENABLED operator flag (parseAiConfig). */
  readonly geminiEnabled: boolean;
  /** A Gemini API key is configured (presence only — never the value). */
  readonly geminiKeyPresent: boolean;
  /** The Gemini port is wired. */
  readonly geminiPortPresent: boolean;
  /** The versioned per-provider eligibility view (Gemini false by default). */
  readonly geminiEligible: boolean;
}

/** One ladder candidate — the provider key and its allowlisted model id. */
export interface AiLadderCandidate {
  readonly provider: AiProvider;
  readonly modelId: string;
}

export interface AiLadder {
  /** Allowlisted candidates in policy order, gated by the static view. */
  readonly candidates: readonly AiLadderCandidate[];
  /** True when a Gemini candidate was dropped ONLY for unverified eligibility. */
  readonly geminiSkippedIneligible: boolean;
}

function isProviderCandidate(model: AiModelRecord, gates: AiLadderGates): boolean {
  switch (model.provider) {
    case 'workers-ai':
      return gates.workersAiPrimaryPresent;
    case 'workers-ai-backup':
      // Fail-closed: BOTH the operator flag AND the wired port are
      // required. A port wired while the flag is off (or the reverse)
      // never reaches the ladder — the wiring sites own the same
      // conjunction; this service-side gate is the layered defense.
      return gates.failoverEnabled && gates.backupPortPresent;
    case 'gemini':
      return (
        gates.geminiEnabled &&
        gates.geminiKeyPresent &&
        gates.geminiPortPresent &&
        gates.geminiEligible
      );
  }
}

/**
 * Build the ladder for ONE caller's static config view. Iterates the
 * versioned allowlist IN ORDER, so a provider's candidates land exactly
 * where the policy puts them.
 */
export function buildAiCandidateLadder(gates: AiLadderGates): AiLadder {
  const candidates: AiLadderCandidate[] = [];
  let geminiSkippedIneligible = false;
  for (const model of AI_MODEL_ALLOWLIST_V2) {
    if (model.provider === 'gemini' && !isProviderCandidate(model, gates)) {
      // Preserve the eligibility distinction for the services' typed
      // zero-candidate classification: dropped for the unverified
      // eligibility gate vs dropped for flag/key/port absence.
      if (
        gates.geminiEnabled &&
        gates.geminiKeyPresent &&
        gates.geminiPortPresent &&
        !gates.geminiEligible
      ) {
        geminiSkippedIneligible = true;
      }
      continue;
    }
    if (!isProviderCandidate(model, gates)) {
      continue;
    }
    candidates.push({ provider: model.provider, modelId: model.modelId });
  }
  return { candidates, geminiSkippedIneligible };
}
