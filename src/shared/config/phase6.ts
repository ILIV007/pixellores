/**
 * Phase 6 configuration surface (AI adapters — ADR-0041 §3).
 *
 * Two INDEPENDENT, fail-closed, non-secret feature flags:
 * - `AI_ENABLED` ('true' | 'false', default 'false') gates the AI draft
 *   service as a whole. While OFF: zero provider calls, zero budget
 *   writes, zero binding access — the outcome is the typed deferred
 *   `ai_disabled`. Absent/invalid configuration must never enable calls
 *   and must never break the existing Telegram/health/job paths.
 * - `AI_GEMINI_ENABLED` ('true' | 'false', default 'false') is the
 *   additional operator gate for the Gemini fallback path. It may be set
 *   'true' ONLY after a documented verification of the CURRENT official
 *   Free-tier eligibility docs: the versioned policy records Gemini
 *   eligibility as PARTIAL since ADR-0067 (the free tier exists per the
 *   2026-11-21 doc-check; the per-project quota is unpublished), so the
 *   flag is the operator opt-in and the 40/day app cap is the bound.
 * - `GEMINI_API_BASE_URL` (optional string, default the official origin)
 *   is the operator-controlled Gemini API origin (ADR-0067): strict
 *   https-only, no credentials/query/fragment. It exists so a relay/proxy
 *   origin can be used later without a code change; an invalid present
 *   value fails the jobs engine closed and never reaches the network.
 * - `EVENT_RELATION_ENABLED` ('true' | 'false', default 'false') is the
 *   INDEPENDENT fail-closed gate for the R1.17 event-relation task
 *   (Phase 5E-1). It NEVER implies AI_ENABLED or EDITORIAL_ENABLED; with
 *   the flag OFF the relation step performs ZERO retrieval, ZERO
 *   adjudication, and ZERO writes, and the accepted normal path stays
 *   intact. Only offline tests/demos turn it on with a fixture port.
 *
 * Format validation runs whenever a value is PRESENT, regardless of the
 * flag (a present-but-invalid value is never silently ignored).
 */
import { defineConfigSpec, type ConfigSpec } from './spec';
import { validateConfig, type ConfigIssue, type ConfigValidationResult } from './validate';

export const AI_FLAG_VALUES = ['true', 'false'] as const;

/**
 * Official Gemini Developer API origin (ADR-0067); the default when
 * GEMINI_API_BASE_URL is absent. Must stay identical to
 * GEMINI_API_DEFAULT_ORIGIN in src/adapters/ai/gemini-adapter.ts
 * (pinned by tests/unit/phase6-config.test.ts).
 */
export const GEMINI_API_BASE_URL_DEFAULT = 'https://generativelanguage.googleapis.com';

/** Strict https-origin shape: host, optional port, optional path — no userinfo, query, or fragment. */
export const GEMINI_API_BASE_URL_PATTERN =
  /^https:\/\/[A-Za-z0-9._~-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%/-]*)?$/;

export const PHASE_6_CONFIG_SPEC: ConfigSpec = defineConfigSpec([
  {
    name: 'AI_ENABLED',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...AI_FLAG_VALUES],
    default: 'false',
    description:
      'AI adapters feature flag (non-secret; ADR-0041). Gates the whole AI draft service — fail-closed default false.',
    phase: 6,
  },
  {
    name: 'AI_GEMINI_ENABLED',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...AI_FLAG_VALUES],
    default: 'false',
    description:
      'Gemini fallback operator gate (non-secret; ADR-0041/ADR-0067). Eligibility is PARTIAL (free tier verified in docs 2026-11-21; per-project quota unpublished) — the flag is the operator opt-in, bounded by the 40/day app cap.',
    phase: 6,
  },
  {
    name: 'GEMINI_API_BASE_URL',
    type: 'string',
    required: false,
    secret: false,
    default: GEMINI_API_BASE_URL_DEFAULT,
    pattern: GEMINI_API_BASE_URL_PATTERN,
    description:
      'Gemini API origin (non-secret; ADR-0067). Operator-controlled relay origin; strict https-only, no credentials/query/fragment. Default is the official origin.',
    phase: 6,
  },
  {
    name: 'EVENT_RELATION_ENABLED',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...AI_FLAG_VALUES],
    default: 'false',
    description:
      'Event-relation adjudication task gate (non-secret; R1.17/ADR-0045). Independent fail-closed flag — never implies AI_ENABLED or EDITORIAL_ENABLED.',
    phase: 6,
  },
]);

/** Validated Phase 6 flag state (values only; no secrets involved). */
export interface AiConfig {
  readonly AI_ENABLED: boolean;
  readonly AI_GEMINI_ENABLED: boolean;
  readonly EVENT_RELATION_ENABLED: boolean;
  /**
   * Resolved Gemini API origin (validated or the official default). An
   * invalid present value is never used: the jobs engine fails closed
   * on the validation result, and this field resolves to the official
   * default instead of the invalid value.
   */
  readonly GEMINI_API_BASE_URL: string;
}

/**
 * Validate the Phase 6 configuration from a raw env-like record. Never
 * throws; issues carry field names and stable reason codes only.
 */
export function parseAiConfig(env: Readonly<Record<string, unknown>>): {
  config: AiConfig;
  result: ConfigValidationResult;
} {
  const result = validateConfig(env, PHASE_6_CONFIG_SPEC);
  return {
    config: {
      AI_ENABLED: result.config.AI_ENABLED === 'true',
      AI_GEMINI_ENABLED: result.config.AI_GEMINI_ENABLED === 'true',
      EVENT_RELATION_ENABLED: result.config.EVENT_RELATION_ENABLED === 'true',
      GEMINI_API_BASE_URL: result.config.GEMINI_API_BASE_URL ?? GEMINI_API_BASE_URL_DEFAULT,
    },
    result,
  };
}

export type { ConfigIssue };
