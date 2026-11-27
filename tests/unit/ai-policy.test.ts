import { describe, expect, it } from 'vitest';
import {
  AI_BUDGET_PRESSURE_RESERVE_UNITS,
  AI_BUDGET_PRESSURE_WARNING_REQUESTS,
  AI_BOUNDS,
  AI_DAILY_REQUEST_ATTEMPT_CAPS,
  AI_MODEL_ALLOWLIST_V2,
  AI_POLICY_VERSION,
  AI_PROMPT_VERSION,
  AI_PROVIDER_ELIGIBILITY_V2,
  defaultProviderEligibility,
  isAllowedModel,
  listModelsForProvider,
} from '../../src/domain/ai/policy';
import { buildNewsDraftSystemPrompt, buildNewsDraftUserPrompt } from '../../src/domain/ai/prompt';
import {
  aiSemanticDraftSchema,
  parseAiSemanticDraftJson,
  type AiOutputRejectCode,
} from '../../src/domain/ai/schema';

/**
 * Versioned AI policy, prompt contract, and output schema (Phase 6,
 * ADR-0041). These pin the fail-closed/free-only policy surface.
 */

describe('AI model policy (ai-policy-v2.3)', () => {
  it('ships a small immutable allowlist: CF primary + CF alternate + CF BACKUP (same ids) + conditional Gemini', () => {
    expect(AI_MODEL_ALLOWLIST_V2).toHaveLength(7);
    expect(listModelsForProvider('workers-ai').map((model) => model.role)).toEqual([
      'primary',
      'alternate',
    ]);
    expect(listModelsForProvider('gemini').map((model) => model.role)).toEqual([
      'primary',
      'alternate',
      'fallback',
    ]);
    // ai-policy-v2.3: the backup account carries the SAME two model ids —
    // the ladder is the same ladder one account over (ADR-0069).
    expect(listModelsForProvider('workers-ai-backup').map((model) => model.modelId)).toEqual([
      '@cf/google/gemma-4-26b-a4b-it',
      '@cf/qwen/qwen3.8-27b',
    ]);
    expect(listModelsForProvider('workers-ai-backup').map((model) => model.role)).toEqual([
      'primary',
      'alternate',
    ]);
    for (const model of listModelsForProvider('workers-ai-backup')) {
      expect(model.requiresEligibility).toBe(false);
    }
  });

  it('uses only explicit model ids — never the literal "auto"', () => {
    for (const model of AI_MODEL_ALLOWLIST_V2) {
      expect(model.modelId).not.toBe('auto');
      expect(model.modelId.length).toBeGreaterThan(0);
    }
  });

  it('marks the Gemini fallback as eligibility-gated (PARTIAL since ADR-0067)', () => {
    const gemini = listModelsForProvider('gemini');
    expect(gemini).toHaveLength(3);
    expect(gemini.map((model) => model.modelId)).toEqual([
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-3.8-flash',
    ]);
    for (const model of gemini) {
      expect(model.requiresEligibility).toBe(true);
    }
    expect(AI_PROVIDER_ELIGIBILITY_V2.gemini).toBe('partial_free_tier');
    expect(AI_PROVIDER_ELIGIBILITY_V2['workers-ai']).toBe('binding_gated');
    // ai-policy-v2.3: the backup REST path's access proof is the wired
    // port itself (flag + secret + var) — the binding_gated family.
    expect(AI_PROVIDER_ELIGIBILITY_V2['workers-ai-backup']).toBe('binding_gated');
  });

  it('derives the default eligibility from the versioned policy', () => {
    expect(defaultProviderEligibility()).toEqual({
      'workers-ai': true,
      'workers-ai-backup': true,
      gemini: true,
    });
  });

  it('rejects unknown model ids for every provider', () => {
    expect(isAllowedModel('workers-ai', '@cf/google/gemma-4-26b-a4b-it')).toBe(true);
    expect(isAllowedModel('workers-ai', '@cf/qwen/qwen3.8-27b')).toBe(true);
    expect(isAllowedModel('workers-ai', 'auto')).toBe(false);
    expect(isAllowedModel('workers-ai', 'gpt-4o')).toBe(false);
    expect(isAllowedModel('gemini', 'gemini-3.5-flash-lite')).toBe(true);
    expect(isAllowedModel('gemini', 'gemini-3.1-flash-lite')).toBe(true);
    expect(isAllowedModel('gemini', 'gemini-3.8-flash')).toBe(true);
    expect(isAllowedModel('workers-ai-backup', '@cf/google/gemma-4-26b-a4b-it')).toBe(true);
    expect(isAllowedModel('workers-ai-backup', '@cf/qwen/qwen3.8-27b')).toBe(true);
    expect(isAllowedModel('workers-ai-backup', 'auto')).toBe(false);
    expect(isAllowedModel('gemini', 'gemini-pro-unlisted')).toBe(false);
  });

  it('rejects the retired Gemini ids (2.5-flash deprecated, 2.5-flash-lite legacy-gated)', () => {
    expect(isAllowedModel('gemini', 'gemini-2.5-flash')).toBe(false);
    expect(isAllowedModel('gemini', 'gemini-2.5-flash-lite')).toBe(false);
  });

  it('rejects the retired ai-policy-v1 Workers AI ids (Cloudflare decommission 2026-11-20)', () => {
    expect(isAllowedModel('workers-ai', '@cf/meta/llama-3.1-8b-instruct-fp8')).toBe(false);
    expect(isAllowedModel('workers-ai', '@cf/qwen/qwen3-30b-a3b-fp8')).toBe(false);
  });

  it('pins the validated application bounds', () => {
    expect(AI_BOUNDS.maxInputUtf8Bytes).toBe(16 * 1024);
    // ai-policy-v2.2: 384 → 2048 — the live gemma probe spent 375/384
    // tokens on thinking for a one-sentence title; real drafts need
    // ~300–600 content tokens plus thinking headroom, so 384 risks
    // truncated JSON → invalid_output after the parse fix.
    expect(AI_BOUNDS.maxOutputTokens).toBe(2048);
    expect(AI_BOUNDS.totalWallDeadlineMs).toBe(60_000);
    expect(AI_BOUNDS.maxProviderAttempts).toBe(3);
    expect(AI_BOUNDS.minEvidenceCount).toBe(1);
    expect(AI_BOUNDS.maxEvidenceCount).toBe(8);
  });

  it('defines per-provider app attempt caps in explicit attempt units', () => {
    // ai-policy-v2.1: workers-ai 40 → 120 — the v2 cap was exhausted by
    // deadline failures (33/40 burned 2026-11-21 before any draft
    // succeeded); 12–18 posts/day × up to 2 attempts + retries + test
    // windows needs the headroom. Gemini stays 40 (fallback, PARTIAL
    // eligibility — ADR-0067).
    expect(AI_DAILY_REQUEST_ATTEMPT_CAPS['workers-ai']).toBe(120);
    // ai-policy-v2.3: the backup account has the same free neuron
    // allowance — the same 120, on its OWN per-account row.
    expect(AI_DAILY_REQUEST_ATTEMPT_CAPS['workers-ai-backup']).toBe(120);
    expect(AI_DAILY_REQUEST_ATTEMPT_CAPS.gemini).toBe(40);
    expect(AI_POLICY_VERSION).toBe('ai-policy-v2.3');
  });

  it('pins the budget-pressure thresholds BEFORE the 120 hard cap (ai-policy-v2.3)', () => {
    // The WARNING fires at the 80% crossing; the RESERVE holds back the
    // last units of each account's day so the autonomous chain backs off
    // with typed budget_pressure instead of riding to the terminal
    // budget_denied — headroom against accounting drift + operator probes.
    expect(AI_BUDGET_PRESSURE_WARNING_REQUESTS).toBe(96);
    expect(AI_BUDGET_PRESSURE_RESERVE_UNITS).toBe(6);
    expect(AI_BUDGET_PRESSURE_WARNING_REQUESTS).toBeLessThan(
      AI_DAILY_REQUEST_ATTEMPT_CAPS['workers-ai'] - AI_BUDGET_PRESSURE_RESERVE_UNITS,
    );
    expect(
      AI_DAILY_REQUEST_ATTEMPT_CAPS['workers-ai'] - AI_BUDGET_PRESSURE_RESERVE_UNITS,
    ).toBeGreaterThan(0);
  });
});

describe('versioned prompt contract', () => {
  it('is deterministic and version-stamped', () => {
    const first = buildNewsDraftSystemPrompt();
    const second = buildNewsDraftSystemPrompt();
    expect(first).toBe(second);
    expect(first).toContain(AI_PROMPT_VERSION);
    expect(AI_PROMPT_VERSION).toBe('pixel-news-draft-v3');
  });

  it('frames news text as untrusted data and forbids tools/HTML/publishing', () => {
    const system = buildNewsDraftSystemPrompt();
    expect(system).toContain('دادهٔ غیرقابل‌اعتماد'); // untrusted data framing
    expect(system).toContain('هیچ ابزاری نداری'); // no tools
    expect(system).toContain('Telegram HTML ممنوع'); // no Telegram HTML
    expect(system).toContain('JSON'); // schema contract
  });

  it('ADR-0070: prompt v3 is raw extraction only — no Soul voice, no Soul form', () => {
    const system = buildNewsDraftSystemPrompt();
    // The Soul v1 voice rules LEFT this prompt for the Gemini-only
    // rewrite prompt v1: none of the v2 voice markers may appear here.
    expect(system).not.toContain('می‌شه');
    expect(system).not.toContain('«تو»');
    expect(system).not.toContain('کلیک‌بیت');
    expect(system).not.toContain('بازی کردم');
    expect(system).not.toContain('زاویهٔ ایرانی');
    expect(system).not.toContain('categoryEmoji');
    expect(system).not.toContain('trustLabel');
    expect(system).not.toContain('🔴');
    expect(system).not.toContain('#رسمی');
    // The prompt SAYS the Soul is not this stage's job.
    expect(system).toContain('صدای Pixel');
    expect(system).toContain('مال این مرحله نیست');
  });

  it('wraps every evidence snippet with its stable id and untrusted markers', () => {
    const user = buildNewsDraftUserPrompt([
      { id: 'src-1:item-42', text: 'متن خبر اول' },
      { id: 'rss:x', text: 'متن خبر دوم' },
    ]);
    expect(user).toContain('شناسه: src-1:item-42');
    expect(user).toContain('شناسه: rss:x');
    expect(user).toContain('<<<SHAHED_SHOROO>>>');
    expect(user).toContain('<<<SHAHED_PAYAN>>>');
    expect(user).toContain('دستور نیست'); // markers are data, not instructions
    // Deterministic given the same evidence.
    expect(user).toBe(
      buildNewsDraftUserPrompt([
        { id: 'src-1:item-42', text: 'متن خبر اول' },
        { id: 'rss:x', text: 'متن خبر دوم' },
      ]),
    );
  });
});

describe('semantic output schema', () => {
  const VALID = {
    headlineFa: 'تیتر خبر',
    summaryFa: 'خلاصهٔ خبر',
    claims: [{ text: 'ادعای اول', evidenceIds: ['src-1:item-42'] }],
  };

  /** Narrow a parse result to its stable rejection code. */
  function rejectCode(rawText: string): AiOutputRejectCode {
    const parsed = parseAiSemanticDraftJson(rawText);
    if (parsed.ok) {
      throw new Error('expected the parse to fail');
    }
    return parsed.code;
  }

  it('accepts a well-formed draft', () => {
    const parsed = parseAiSemanticDraftJson(JSON.stringify(VALID));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.draft.headlineFa).toBe('تیتر خبر');
    }
  });

  it('rejects malformed and truncated JSON', () => {
    expect(parseAiSemanticDraftJson('not json at all').ok).toBe(false);
    expect(rejectCode('{"headlineFa": "ناقص')).toBe('malformed_json');
    expect(rejectCode('')).toBe('empty_output');
    expect(rejectCode('   ')).toBe('empty_output');
  });

  it('rejects unexpected fields and schema mismatches', () => {
    expect(rejectCode(JSON.stringify({ ...VALID, extra: true }))).toBe('schema_mismatch');
    expect(rejectCode(JSON.stringify({ headlineFa: '', summaryFa: 'x', claims: [] }))).toBe(
      'schema_mismatch',
    );
    expect(rejectCode(JSON.stringify({ headlineFa: 'x', summaryFa: 'y' }))).toBe('schema_mismatch');
  });

  it('ADR-0070: a v2-shaped output (Soul fields) is rejected — raw extraction only', () => {
    // Prompt v3 never produces categoryEmoji/trustLabel; the strict
    // schema rejects them as unknown fields, so a v2-shaped model
    // answer can never slip through as a valid v3 draft.
    expect(
      rejectCode(JSON.stringify({ ...VALID, categoryEmoji: '🔵', trustLabel: '#گزارش‌شده' })),
    ).toBe('schema_mismatch');
    expect(rejectCode(JSON.stringify({ ...VALID, categoryEmoji: '🎲' }))).toBe('schema_mismatch');
    expect(rejectCode(JSON.stringify({ ...VALID, trustLabel: '#خبر' }))).toBe('schema_mismatch');
  });

  it('bounds claim count and sizes', () => {
    const tooManyClaims = {
      headlineFa: 'x',
      summaryFa: 'y',
      claims: Array.from({ length: 11 }, () => ({ text: 'claim', evidenceIds: ['a'] })),
    };
    expect(rejectCode(JSON.stringify(tooManyClaims))).toBe('schema_mismatch');
    const oversizedClaim = {
      headlineFa: 'x',
      summaryFa: 'y',
      claims: [{ text: 'a'.repeat(501), evidenceIds: ['a'] }],
    };
    expect(rejectCode(JSON.stringify(oversizedClaim))).toBe('schema_mismatch');
  });

  it('pins the raw zod schema strictness directly', () => {
    expect(aiSemanticDraftSchema.safeParse(VALID).success).toBe(true);
    expect(aiSemanticDraftSchema.safeParse(null).success).toBe(false);
  });
});
