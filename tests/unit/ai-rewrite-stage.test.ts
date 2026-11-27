import { describe, expect, it } from 'vitest';
import type { DbExecutor, DbQueryMeta, DbRows } from '../../src/adapters/db/db-executor';
import {
  AI_REWRITE_MAX_ATTEMPTS_PER_DRAFT,
  AI_REWRITE_MAX_OUTPUT_TOKENS,
} from '../../src/domain/ai/policy';
import {
  AI_REWRITE_PROMPT_VERSION,
  AI_REWRITE_SOUL_VERSION,
  buildNewsRewriteSystemPrompt,
  buildNewsRewriteUserPrompt,
} from '../../src/domain/ai/rewrite-prompt';
import {
  aiRewriteOutputSchema,
  parseAiRewriteOutputJson,
  type AiRewriteOutputRejectCode,
} from '../../src/domain/ai/rewrite-schema';
import {
  checkRewritePreservesNumbers,
  foldDigitsForRewriteGuard,
} from '../../src/domain/ai/rewrite-guard';
import { createAiRewriteService } from '../../src/application/ai/rewrite-service';
import type { AiCallOutcome, AiProviderPort } from '../../src/domain/ai/types';
import type { AiSemanticDraft } from '../../src/domain/ai/types';
import {
  applyRewriteToDocument,
  buildDraftDocument,
  markRewriteFailedOnDocument,
  markRewritePendingOnDocument,
  parseDraftDocumentForRewrite,
  type StoredDraftDocument,
} from '../../src/domain/editorial/mapper';
import { buildEvidenceGuardReport } from '../../src/domain/editorial/evidence-guard';
import { buildCandidateDiscoveryReport } from '../../src/domain/editorial/candidate-discovery';
import { buildCandidateAssessmentReport } from '../../src/domain/editorial/candidate-assessment';
import { emptyEntityMentionsReport } from '../../src/domain/editorial/entity-mentions';
import { disabledEventRelationReport } from '../../src/domain/editorial/event-relation-decision';
import {
  aiRunIdForAttempt,
  aiRunIdForRewriteAttempt,
  editorialRewriteDraftIdempotencyKey,
  rewriteJobIdForDraft,
} from '../../src/domain/editorial/identity';
import { msUntilNextTehranMidnight } from '../../src/shared/time/tehran-day';
import { createLogger } from '../../src/observability/logger';

/**
 * ADR-0070 — the Gemini-only Soul rewrite stage: prompt v1 byte-pin,
 * output schema, claim-preservation guard, Gemini-only service, mapper
 * rewrite-block helpers, and the new identity/time helpers. Fully
 * offline; the service tests use the same injected-fake pattern as
 * ai-draft-service.test.ts (no native binding, no network, no real D1).
 */

describe('rewrite prompt v1 (ADR-0070 §3)', () => {
  it('is deterministic and version-stamped', () => {
    const first = buildNewsRewriteSystemPrompt();
    const second = buildNewsRewriteSystemPrompt();
    expect(first).toBe(second);
    expect(first).toContain(AI_REWRITE_PROMPT_VERSION);
    expect(AI_REWRITE_PROMPT_VERSION).toBe('pixel-news-rewrite-v1');
    expect(AI_REWRITE_SOUL_VERSION).toBe('v1');
  });

  it('carries the Soul v1 voice rules that left the Workers AI draft prompt', () => {
    const system = buildNewsRewriteSystemPrompt();
    expect(system).toContain('می‌شه'); // conversational register
    expect(system).toContain('«تو»'); // second-person address
    expect(system).toContain('کلیک‌بیت');
    expect(system).toContain('بازی کردم'); // fabricated experience banned
    expect(system).toContain('زاویهٔ ایرانی');
    expect(system).toContain('categoryEmoji');
    expect(system).toContain('trustLabel');
    expect(system).toContain('🔴');
    expect(system).toContain('#رسمی');
    expect(system).toContain('Soul');
  });

  it('forbids invention and Telegram HTML, and names the output fields only', () => {
    const system = buildNewsRewriteSystemPrompt();
    expect(system).toContain('بدون فکت تازه'); // no invented facts
    expect(system).toContain('دادهٔ غیرقابل‌اعتماد'); // raw draft is untrusted data
    expect(system).toContain('Telegram HTML ممنوع');
    expect(system).toContain('headlineFa');
    expect(system).toContain('summaryFa');
    // No claims field: the rewrite re-voices the raw draft, it does not
    // re-extract facts.
    expect(system).not.toContain('"claims"');
    expect(system).toContain('عدد');
  });

  it('wraps the raw draft in data markers and never re-sends the source report', () => {
    const user = buildNewsRewriteUserPrompt({
      headlineFa: 'تیتر خام',
      summaryFa: 'خلاصهٔ خام',
      claimTexts: ['ادعای اول'],
      sourceName: 'منبع رسمی',
    });
    expect(user).toContain('<<<RAW_DRAFT_SHOROO>>>');
    expect(user).toContain('<<<RAW_DRAFT_PAYAN>>>');
    expect(user).toContain('تیتر خام');
    expect(user).toContain('خلاصهٔ خام');
    expect(user).toContain('ادعای اول');
    expect(user).toContain('منبع رسمی');
    expect(user).not.toContain('SHAHED');
    // Deterministic given the same raw draft.
    expect(user).toBe(
      buildNewsRewriteUserPrompt({
        headlineFa: 'تیتر خام',
        summaryFa: 'خلاصهٔ خام',
        claimTexts: ['ادعای اول'],
        sourceName: 'منبع رسمی',
      }),
    );
  });
});

describe('rewrite output schema (ADR-0070 §3)', () => {
  const VALID = {
    headlineFa: 'تیتر بازنویسی‌شده',
    summaryFa: 'خلاصهٔ بازنویسی‌شده',
    categoryEmoji: '🔵',
    trustLabel: '#گزارش‌شده',
  };

  /** Narrow a parse result to its stable rejection code. */
  function rewriteRejectCode(rawText: string): AiRewriteOutputRejectCode {
    const parsed = parseAiRewriteOutputJson(rawText);
    if (parsed.ok) {
      throw new Error('expected the parse to fail');
    }
    return parsed.code;
  }

  it('accepts a well-formed rewrite', () => {
    const parsed = parseAiRewriteOutputJson(JSON.stringify(VALID));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.rewrite.headlineFa).toBe('تیتر بازنویسی‌شده');
      expect(parsed.rewrite.trustLabel).toBe('#گزارش‌شده');
    }
  });

  it('rejects malformed, empty and schema-mismatched output', () => {
    expect(parseAiRewriteOutputJson('not json').ok).toBe(false);
    expect(rewriteRejectCode('')).toBe('empty_output');
    expect(rewriteRejectCode('   ')).toBe('empty_output');
    expect(rewriteRejectCode('{"headlineFa": "ناقص')).toBe('malformed_json');
    expect(rewriteRejectCode(JSON.stringify({ ...VALID, extra: true }))).toBe('schema_mismatch');
  });

  it('rejects a claims field and out-of-vocabulary Soul form values', () => {
    // The rewrite output has NO claims: it re-voices, it does not re-extract.
    expect(rewriteRejectCode(JSON.stringify({ ...VALID, claims: [] }))).toBe('schema_mismatch');
    expect(rewriteRejectCode(JSON.stringify({ ...VALID, categoryEmoji: '🎲' }))).toBe(
      'schema_mismatch',
    );
    expect(rewriteRejectCode(JSON.stringify({ ...VALID, trustLabel: '#خبر' }))).toBe(
      'schema_mismatch',
    );
    // Every Soul v1 §3 value parses.
    for (const categoryEmoji of ['🔴', '🚨', '🏆', '🎮', '🟢', '🔵']) {
      expect(parseAiRewriteOutputJson(JSON.stringify({ ...VALID, categoryEmoji })).ok).toBe(true);
    }
    for (const trustLabel of ['#رسمی', '#تأییدشده', '#گزارش‌شده', '#شایعه', '#لیک', '#تکذیب‌شده']) {
      expect(parseAiRewriteOutputJson(JSON.stringify({ ...VALID, trustLabel })).ok).toBe(true);
    }
  });

  it('is strict at the zod level', () => {
    expect(aiRewriteOutputSchema.safeParse({ ...VALID, claims: [] }).success).toBe(false);
  });
});

describe('claim-preservation guard (ADR-0070 §3, ADR-0066 digit folding)', () => {
  const RAW_HEADLINE = 'فروش ۳٫۷۹ میلیارد دلار شد';
  const RAW_SUMMARY = 'استودیو از فروش خبر داد';
  const RAW_CLAIMS = ['فروش ۳٫۷۹ میلیارد دلار گزارش شد'];

  it('folds Persian/Arabic digits and separators to Latin before comparing', () => {
    expect(foldDigitsForRewriteGuard('۳٫۷۹ میلیارد')).toBe('3.79 میلیارد');
    expect(foldDigitsForRewriteGuard('١٢٬٣٤٥ تومان')).toBe('12,345 تومان');
    expect(foldDigitsForRewriteGuard('بدون عدد')).toBe('بدون عدد');
    // The ADR-0066 map covers digits + ٫/٬ only: the percent sign ٪ is
    // NOT folded — only its digits are.
    expect(foldDigitsForRewriteGuard('٪۵۰')).toBe('٪50');
  });

  it('accepts the $3.79B case: rewritten 3.79 matches raw ۳٫۷۹ after folding', () => {
    const outcome = checkRewritePreservesNumbers({
      rawHeadlineFa: RAW_HEADLINE,
      rawSummaryFa: RAW_SUMMARY,
      rawClaimTexts: RAW_CLAIMS,
      rewrittenHeadlineFa: 'فروش 3.79 میلیارد دلار شد',
      rewrittenSummaryFa: 'استودیو از فروش 3.79 میلیارد دلاری خبر داد',
    });
    expect(outcome.ok).toBe(true);
  });

  it('accepts a rewritten number that appears in a claim, not just headline/summary', () => {
    const outcome = checkRewritePreservesNumbers({
      rawHeadlineFa: RAW_HEADLINE,
      rawSummaryFa: RAW_SUMMARY,
      rawClaimTexts: RAW_CLAIMS,
      rewrittenHeadlineFa: 'خبر فروش',
      rewrittenSummaryFa: 'استودیو از فروش 3.79 میلیارد دلاری خبر داد',
    });
    expect(outcome.ok).toBe(true);
  });

  it('refuses a rewritten number that is not in the raw text', () => {
    const outcome = checkRewritePreservesNumbers({
      rawHeadlineFa: RAW_HEADLINE,
      rawSummaryFa: RAW_SUMMARY,
      rawClaimTexts: RAW_CLAIMS,
      rewrittenHeadlineFa: 'فروش 3.80 میلیارد دلار شد',
      rewrittenSummaryFa: 'استودیو از فروش خبر داد',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('number_not_in_raw');
      // The rejection names only the folded offending token — never raw text.
      expect(outcome.token).toBe('3.80');
    }
  });

  it('refuses an empty rewrite', () => {
    const outcome = checkRewritePreservesNumbers({
      rawHeadlineFa: RAW_HEADLINE,
      rawSummaryFa: RAW_SUMMARY,
      rawClaimTexts: RAW_CLAIMS,
      rewrittenHeadlineFa: '',
      rewrittenSummaryFa: '',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('empty_rewrite');
    }
  });

  it('passes a rewrite with no numbers at all', () => {
    const outcome = checkRewritePreservesNumbers({
      rawHeadlineFa: 'تیتر',
      rawSummaryFa: 'خلاصه',
      rawClaimTexts: [],
      rewrittenHeadlineFa: 'تیتر تازه',
      rewrittenSummaryFa: 'خلاصهٔ تازه',
    });
    expect(outcome.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mapper: soulForm optional + rewrite-block helpers
// ---------------------------------------------------------------------------

const ITEM_ID = 'item-0001';
const HASH = 'a'.repeat(64);

const GUARD_REPORT = buildEvidenceGuardReport({
  snapshot: { sourceItemId: ITEM_ID, contentHash: HASH },
  evidence: { evidenceId: ITEM_ID, excerptText: 'متن شاهد آزمایشی', excerptTruncated: false },
  draftClaims: [{ text: 'ادعای مدل', evidenceIds: [ITEM_ID] }],
  draftHeadlineFa: 'تیتر مدل',
  draftSummaryFa: 'خلاصه مدل',
  draftSourceItemId: ITEM_ID,
});
const NO_CANDIDATES_REPORT = buildCandidateDiscoveryReport({
  snapshot: { sourceItemId: ITEM_ID, contentHash: HASH },
  storyId: 'edst_test_story',
  lookups: [],
  matches: [],
});
const NO_CANDIDATES_ASSESSMENT = buildCandidateAssessmentReport({
  discovery: NO_CANDIDATES_REPORT,
});
const NO_MENTIONS_REPORT = emptyEntityMentionsReport({ sourceItemId: ITEM_ID, contentHash: HASH });
const DISABLED_EVENT_RELATION_REPORT = disabledEventRelationReport({
  sourceItemId: ITEM_ID,
  contentHash: HASH,
});

function buildRawBuiltDraft(semanticDraft: AiSemanticDraft) {
  return buildDraftDocument({
    sourceItemId: ITEM_ID,
    sourceName: 'منبع رسمی',
    excerpt: { text: 'متن شاهد آزمایشی', truncated: false },
    semanticDraft,
    evidenceGuard: GUARD_REPORT,
    candidateDiscovery: NO_CANDIDATES_REPORT,
    candidateAssessment: NO_CANDIDATES_ASSESSMENT,
    entityMentions: NO_MENTIONS_REPORT,
    eventRelation: DISABLED_EVENT_RELATION_REPORT,
  });
}

function buildRawDocument(semanticDraft: AiSemanticDraft): StoredDraftDocument {
  return buildRawBuiltDraft(semanticDraft).document;
}

/** The stored document_json shape: the BARE inner document (what the
 * prepare-draft handler stores via canonicalizeJson(document.document)),
 * not the build wrapper. */
function buildRawDocumentJson(semanticDraft: AiSemanticDraft): string {
  return JSON.stringify(buildRawBuiltDraft(semanticDraft).document);
}

describe('mapper: soulForm optional + rewrite block (ADR-0070 §4)', () => {
  it('a raw v3 draft carries NO soulForm (absence is the honest shape)', () => {
    const document = buildRawDocument({
      headlineFa: 'تیتر خام',
      summaryFa: 'خلاصهٔ خام',
      claims: [{ text: 'ادعای مدل', evidenceIds: [ITEM_ID] }],
    });
    expect(document.soulForm).toBeUndefined();
    expect('soulForm' in document).toBe(false);
    const parsed = parseDraftDocumentForRewrite(
      buildRawDocumentJson({
        headlineFa: 'تیتر خام',
        summaryFa: 'خلاصهٔ خام',
        claims: [{ text: 'ادعای مدل', evidenceIds: [ITEM_ID] }],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.attemptsSpent).toBe(0);
    expect(parsed?.alreadyRewritten).toBe(false);
    expect(parsed?.alreadyFailed).toBe(false);
  });

  it('a v2 legacy draft still carries soulForm when both fields are present', () => {
    const document = buildRawDocument({
      headlineFa: 'تیتر خام',
      summaryFa: 'خلاصهٔ خام',
      categoryEmoji: '🔵',
      trustLabel: '#گزارش‌شده',
      claims: [{ text: 'ادعای مدل', evidenceIds: [ITEM_ID] }],
    });
    expect(document.soulForm).toEqual({ categoryEmoji: '🔵', trustLabel: '#گزارش‌شده' });
  });

  it('applyRewrite replaces the display text and preserves the raw pair exactly once', () => {
    const document = buildRawDocument({
      headlineFa: 'تیتر خام',
      summaryFa: 'خلاصهٔ خام',
      claims: [{ text: 'ادعای مدل', evidenceIds: [ITEM_ID] }],
    });
    const rewritten = applyRewriteToDocument(document, {
      headlineFa: 'تیتر بازنویسی‌شده',
      summaryFa: 'خلاصهٔ بازنویسی‌شده',
      categoryEmoji: '🔵',
      trustLabel: '#گزارش‌شده',
      model: 'gemini-3.5-flash-lite',
      promptVersion: 'pixel-news-rewrite-v1',
      soulVersion: 'v1',
      attempts: 1,
      rewrittenAtMs: 1_700_000_000_000,
    });
    expect(rewritten.headlineFa).toBe('تیتر بازنویسی‌شده');
    expect(rewritten.summaryFa).toBe('خلاصهٔ بازنویسی‌شده');
    expect(rewritten.rawHeadlineFa).toBe('تیتر خام');
    expect(rewritten.rawSummaryFa).toBe('خلاصهٔ خام');
    expect(rewritten.soulForm).toEqual({ categoryEmoji: '🔵', trustLabel: '#گزارش‌شده' });
    expect(rewritten.rewrite).toEqual({
      status: 'rewritten',
      model: 'gemini-3.5-flash-lite',
      promptVersion: 'pixel-news-rewrite-v1',
      soulVersion: 'v1',
      attempts: 1,
      rewrittenAtMs: 1_700_000_000_000,
    });
    // A second rewrite NEVER overwrites the preserved original raw pair.
    const again = applyRewriteToDocument(rewritten, {
      headlineFa: 'تیتر دوم',
      summaryFa: 'خلاصهٔ دوم',
      categoryEmoji: '🎮',
      trustLabel: '#رسمی',
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'pixel-news-rewrite-v1',
      soulVersion: 'v1',
      attempts: 2,
      rewrittenAtMs: 1_700_000_000_001,
    });
    expect(again.rawHeadlineFa).toBe('تیتر خام');
    expect(again.rawSummaryFa).toBe('خلاصهٔ خام');
    expect(again.headlineFa).toBe('تیتر دوم');
    // And the parse sees the rewritten state with its spent count.
    const parsed = parseDraftDocumentForRewrite(JSON.stringify(again));
    expect(parsed?.alreadyRewritten).toBe(true);
    expect(parsed?.attemptsSpent).toBe(2);
  });

  it('marks failed and pending, and parse rejects malformed documents', () => {
    const document = buildRawDocument({
      headlineFa: 'تیتر خام',
      summaryFa: 'خلاصهٔ خام',
      claims: [{ text: 'ادعای مدل', evidenceIds: [ITEM_ID] }],
    });
    const failed = markRewriteFailedOnDocument(document, {
      reason: 'provider_unavailable',
      promptVersion: 'pixel-news-rewrite-v1',
      soulVersion: 'v1',
      attempts: 2,
      failedAtMs: 1_700_000_000_000,
    });
    expect(failed.rewrite).toEqual({
      status: 'failed',
      model: 'gemini',
      promptVersion: 'pixel-news-rewrite-v1',
      soulVersion: 'v1',
      attempts: 2,
      failedAtMs: 1_700_000_000_000,
      reason: 'provider_unavailable',
    });
    expect(failed.headlineFa).toBe('تیتر خام'); // failed: display text untouched
    expect(failed.rawHeadlineFa).toBeUndefined();

    const pending = markRewritePendingOnDocument(document, {
      promptVersion: 'pixel-news-rewrite-v1',
      soulVersion: 'v1',
      attempts: 1,
    });
    expect(pending.rewrite).toEqual({
      status: 'pending',
      model: 'gemini',
      promptVersion: 'pixel-news-rewrite-v1',
      soulVersion: 'v1',
      attempts: 1,
    });

    const rawJson = buildRawDocumentJson({
      headlineFa: 'تیتر خام',
      summaryFa: 'خلاصهٔ خام',
      claims: [{ text: 'ادعای مدل', evidenceIds: [ITEM_ID] }],
    });
    const rawDoc = JSON.parse(rawJson) as Record<string, unknown>;
    expect(parseDraftDocumentForRewrite(JSON.stringify({ ...rawDoc, headlineFa: '' }))).toBeNull();
    expect(
      parseDraftDocumentForRewrite(
        JSON.stringify({ ...rawDoc, modelClaims: [{ text: '', evidenceIds: [] }] }),
      ),
    ).toBeNull();
    expect(
      parseDraftDocumentForRewrite(JSON.stringify({ ...rawDoc, rewrite: { status: 'weird' } })),
    ).toBeNull();
    expect(parseDraftDocumentForRewrite('not json')).toBeNull();
    expect(parseDraftDocumentForRewrite(JSON.stringify({ headlineFa: 'x' }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rewrite service over injected fakes
// ---------------------------------------------------------------------------

interface FakeExecutorState {
  readonly batchCalls: number[];
  readonly runCalls: number[];
  failStorage: boolean;
  denyAll: boolean;
  breakerOpen: boolean;
  /**
   * Charged-attempt readback for `readAiBudget` (ai-policy-v2.3
   * classification): null = no budgets row (0 charged); a number = the
   * stored `requests` count for the provider's Tehran day.
   */
  chargedAttempts: number | null;
}

function createFakeExecutor(nowMs: number): FakeExecutorState & DbExecutor {
  const state = {
    batchCalls: [] as number[],
    runCalls: [] as number[],
    failStorage: false,
    denyAll: false,
    breakerOpen: false,
    chargedAttempts: null as number | null,
    async query<T>(_: { sql: string }): Promise<DbRows<T>> {
      return { rows: [] as T[], meta: { durationMs: 0, changes: 0 } };
    },
    async first<T>(input: { sql: string }): Promise<T | null> {
      // The breaker reads `settings`, the budget readback reads
      // `budgets` — the fake answers each from its own state.
      if (input.sql.includes('budgets')) {
        if (state.chargedAttempts === null) {
          return null;
        }
        return {
          requests: state.chargedAttempts,
          input_tokens: 0,
          output_tokens: 0,
        } as unknown as T;
      }
      if (state.breakerOpen) {
        return {
          value_json: JSON.stringify({
            state: 'open',
            consecutive_failures: 5,
            opened_at_ms: nowMs,
            updated_at_ms: nowMs,
          }),
        } as unknown as T;
      }
      return null;
    },
    async run(_: { sql: string }): Promise<DbQueryMeta> {
      state.runCalls.push(1);
      if (state.failStorage) {
        throw new Error('storage down');
      }
      return { durationMs: 0, changes: state.denyAll ? 0 : 1 };
    },
    async batch(statements: readonly { sql: string }[]): Promise<readonly DbQueryMeta[]> {
      state.batchCalls.push(statements.length);
      if (state.failStorage) {
        throw new Error('storage down');
      }
      return statements.map(() => ({ durationMs: 0, changes: state.denyAll ? 0 : 1 }));
    },
  };
  return state as FakeExecutorState & DbExecutor;
}

type FakeGeminiPort = {
  readonly calls: { modelId: string; maxOutputTokens: number }[];
  setOutcomes(next: readonly AiCallOutcome[]): void;
} & AiProviderPort;

function createFakeGeminiPort(outcomes: readonly AiCallOutcome[] = []): FakeGeminiPort {
  const calls: { modelId: string; maxOutputTokens: number }[] = [];
  const queue = [...outcomes];
  return {
    provider: 'gemini',
    calls,
    setOutcomes(next: readonly AiCallOutcome[]) {
      queue.length = 0;
      queue.push(...next);
    },
    async complete(input) {
      calls.push({ modelId: input.modelId, maxOutputTokens: input.maxOutputTokens });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('fake port exhausted its scripted outcomes');
      }
      return next;
    },
  } as FakeGeminiPort;
}

const NOW = 1_700_000_000_000;

function createFakeClock(start = NOW): { now(): number } & { setNow(value: number): void } {
  let current = start;
  return {
    now: () => current,
    setNow(value: number) {
      current = value;
    },
  };
}

const VALID_REWRITE_JSON = JSON.stringify({
  headlineFa: 'تیتر بازنویسی‌شده',
  summaryFa: 'خلاصهٔ بازنویسی‌شده',
  categoryEmoji: '🔵',
  trustLabel: '#گزارش‌شده',
});

const REWRITE_REQUEST = {
  draftId: 'edd_test',
  headlineFa: 'تیتر خام',
  summaryFa: 'خلاصهٔ خام',
  claimTexts: ['ادعای اول'],
  sourceName: 'منبع رسمی',
};

function baseRewriteService(
  overrides: {
    executor?: DbExecutor;
    port?: FakeGeminiPort;
    aiEnabled?: boolean;
    geminiEnabled?: boolean;
    rewriteEnabled?: boolean;
    geminiApiKeyPresent?: boolean;
  } = {},
): {
  service: ReturnType<typeof createAiRewriteService>;
  port: FakeGeminiPort;
  logLines: string[];
} {
  const executor = overrides.executor ?? createFakeExecutor(NOW);
  const port =
    overrides.port ?? createFakeGeminiPort([{ kind: 'ok', rawText: VALID_REWRITE_JSON }]);
  const logLines: string[] = [];
  const logger = createLogger({
    level: 'info',
    sink: (_level, line) => {
      logLines.push(line);
    },
  });
  const service = createAiRewriteService({
    config: {
      aiEnabled: overrides.aiEnabled ?? true,
      geminiEnabled: overrides.geminiEnabled ?? true,
      rewriteEnabled: overrides.rewriteEnabled ?? true,
      geminiApiKeyPresent: overrides.geminiApiKeyPresent ?? true,
      // The fixture wires ONLY the Gemini port — no Workers AI binding.
      workersAiBindingPresent: false,
    },
    executor,
    ports: { gemini: port },
    clock: createFakeClock(NOW),
    logger,
  });
  return { service, port, logLines };
}

describe('rewrite service (ADR-0070 §3)', () => {
  it('rewrites with Gemini only, in ladder order, within the rewrite token cap', async () => {
    const { service, port } = baseRewriteService();
    const outcome = await service.rewriteNewsDraft(REWRITE_REQUEST);
    expect(outcome.kind).toBe('rewritten');
    if (outcome.kind === 'rewritten') {
      expect(outcome.rewrite.headlineFa).toBe('تیتر بازنویسی‌شده');
      expect(outcome.rewrite.trustLabel).toBe('#گزارش‌شده');
      expect(outcome.modelId).toBe('gemini-3.5-flash-lite');
      expect(outcome.attempts).toHaveLength(1);
      expect(outcome.attempts[0]?.modelId).toBe('gemini-3.5-flash-lite');
      expect(outcome.attempts[0]?.outcome).toBe('succeeded');
      expect(outcome.attempts[0]?.promptVersion).toBe('pixel-news-rewrite-v1');
    }
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.maxOutputTokens).toBe(AI_REWRITE_MAX_OUTPUT_TOKENS);
    expect(AI_REWRITE_MAX_OUTPUT_TOKENS).toBe(1024);
    expect(AI_REWRITE_MAX_ATTEMPTS_PER_DRAFT).toBe(2);
  });

  it('flag off makes zero provider calls (rewrite_disabled)', async () => {
    const { service, port } = baseRewriteService({ rewriteEnabled: false });
    const outcome = await service.rewriteNewsDraft(REWRITE_REQUEST);
    expect(outcome.kind).toBe('deferred');
    if (outcome.kind === 'deferred') {
      expect(outcome.reason).toBe('rewrite_disabled');
      expect(outcome.attempts).toHaveLength(0);
    }
    expect(port.calls).toHaveLength(0);
  });

  it('aiEnabled off and geminiEnabled off also make zero calls', async () => {
    const off1 = baseRewriteService({ aiEnabled: false });
    const outcome1 = await off1.service.rewriteNewsDraft(REWRITE_REQUEST);
    expect(outcome1.kind).toBe('deferred');
    if (outcome1.kind === 'deferred') {
      expect(outcome1.reason).toBe('ai_disabled');
      expect(outcome1.attempts).toHaveLength(0);
    }
    expect(off1.port.calls).toHaveLength(0);

    const off2 = baseRewriteService({ geminiEnabled: false });
    const outcome2 = await off2.service.rewriteNewsDraft(REWRITE_REQUEST);
    expect(outcome2.kind).toBe('deferred');
    if (outcome2.kind === 'deferred') {
      expect(outcome2.reason).toBe('no_free_path');
      expect(outcome2.attempts).toHaveLength(0);
    }
    expect(off2.port.calls).toHaveLength(0);
  });

  it('a missing Gemini key defers with zero calls (key_missing)', async () => {
    const { service, port } = baseRewriteService({ geminiApiKeyPresent: false });
    const outcome = await service.rewriteNewsDraft(REWRITE_REQUEST);
    expect(outcome.kind).toBe('deferred');
    if (outcome.kind === 'deferred') {
      expect(outcome.reason).toBe('key_missing');
    }
    expect(port.calls).toHaveLength(0);
  });

  it('an invalid request defers with zero calls (input_invalid)', async () => {
    const { service, port } = baseRewriteService();
    const outcome = await service.rewriteNewsDraft({ ...REWRITE_REQUEST, draftId: '' });
    expect(outcome.kind).toBe('deferred');
    if (outcome.kind === 'deferred') {
      expect(outcome.reason).toBe('input_invalid');
    }
    expect(port.calls).toHaveLength(0);
  });

  it('a safety refusal is terminal: one attempt, no ladder', async () => {
    const { service, port } = baseRewriteService({
      port: createFakeGeminiPort([{ kind: 'refused' }]),
    });
    const outcome = await service.rewriteNewsDraft(REWRITE_REQUEST);
    expect(outcome.kind).toBe('refusal');
    if (outcome.kind === 'refusal') {
      expect(outcome.reason).toBe('provider_safety_refusal');
      expect(outcome.attempts).toHaveLength(1);
      expect(outcome.attempts[0]?.outcome).toBe('refused');
    }
    expect(port.calls).toHaveLength(1);
  });

  it('a guard failure is an invalid_output attempt and the ladder continues', async () => {
    const rawWithNumber = {
      draftId: 'edd_test',
      headlineFa: 'فروش ۳٫۷۹ میلیارد دلار شد',
      summaryFa: 'استودیو از فروش خبر داد',
      claimTexts: ['فروش ۳٫۷۹ میلیارد دلار گزارش شد'],
      sourceName: 'منبع رسمی',
    };
    const badRewrite = JSON.stringify({
      headlineFa: 'فروش 3.80 میلیارد دلار شد',
      summaryFa: 'استودیو از فروش خبر داد',
      categoryEmoji: '🔵',
      trustLabel: '#گزارش‌شده',
    });
    const { service, port } = baseRewriteService({
      port: createFakeGeminiPort([
        { kind: 'ok', rawText: badRewrite },
        { kind: 'ok', rawText: VALID_REWRITE_JSON },
      ]),
    });
    const outcome = await service.rewriteNewsDraft(rawWithNumber);
    expect(outcome.kind).toBe('rewritten');
    if (outcome.kind === 'rewritten') {
      expect(outcome.attempts).toHaveLength(2);
      expect(outcome.attempts[0]?.outcome).toBe('invalid_output');
      expect(outcome.attempts[0]?.modelId).toBe('gemini-3.5-flash-lite');
      expect(outcome.attempts[1]?.outcome).toBe('succeeded');
      expect(outcome.attempts[1]?.modelId).toBe('gemini-3.1-flash-lite');
    }
    expect(port.calls).toHaveLength(2);
  });

  it('a guard failure on every model defers as provider_unavailable', async () => {
    const rawWithNumber = {
      draftId: 'edd_test',
      headlineFa: 'فروش ۳٫۷۹ میلیارد دلار شد',
      summaryFa: 'استودیو از فروش خبر داد',
      claimTexts: ['فروش ۳٫۷۹ میلیارد دلار گزارش شد'],
      sourceName: 'منبع رسمی',
    };
    const badRewrite = JSON.stringify({
      headlineFa: 'فروش 3.80 میلیارد دلار شد',
      summaryFa: 'استودیو از فروش خبر داد',
      categoryEmoji: '🔵',
      trustLabel: '#گزارش‌شده',
    });
    const { service, port } = baseRewriteService({
      port: createFakeGeminiPort([
        { kind: 'ok', rawText: badRewrite },
        { kind: 'ok', rawText: badRewrite },
        { kind: 'ok', rawText: badRewrite },
      ]),
    });
    const outcome = await service.rewriteNewsDraft(rawWithNumber);
    expect(outcome.kind).toBe('deferred');
    if (outcome.kind === 'deferred') {
      expect(outcome.reason).toBe('provider_unavailable');
      expect(outcome.attempts).toHaveLength(3);
      expect(outcome.attempts.every((attempt) => attempt.outcome === 'invalid_output')).toBe(true);
    }
    expect(port.calls).toHaveLength(3);
  });

  it('quota_denied stops the ladder and charges nothing further', async () => {
    const executor = createFakeExecutor(NOW);
    executor.denyAll = true;
    const { service, port } = baseRewriteService({ executor });
    const outcome = await service.rewriteNewsDraft(REWRITE_REQUEST);
    expect(outcome.kind).toBe('deferred');
    if (outcome.kind === 'deferred') {
      expect(outcome.reason).toBe('budget_denied');
      // The denied authorization IS recorded as a quota_denied attempt.
      expect(outcome.attempts).toHaveLength(1);
      expect(outcome.attempts[0]?.outcome).toBe('quota_denied');
    }
    expect(port.calls).toHaveLength(0);
  });

  it('a reserve-window denial classifies as retryable budget_pressure (ai-policy-v2.3)', async () => {
    // Effective autonomous cap is 40 − 6 = 34: with 34 charged the
    // authorization denies INSIDE the reserve window (34 ≤ count < 40).
    const executor = createFakeExecutor(NOW);
    executor.denyAll = true;
    executor.chargedAttempts = 34;
    const { service, port } = baseRewriteService({ executor });
    const outcome = await service.rewriteNewsDraft(REWRITE_REQUEST);
    expect(outcome.kind).toBe('deferred');
    if (outcome.kind === 'deferred') {
      expect(outcome.reason).toBe('budget_pressure');
      expect(outcome.attempts).toHaveLength(1);
      expect(outcome.attempts[0]?.outcome).toBe('quota_denied');
    }
    expect(port.calls).toHaveLength(0);
  });

  it('a hard-cap denial stays budget_denied (charged at the 40 cap)', async () => {
    const executor = createFakeExecutor(NOW);
    executor.denyAll = true;
    executor.chargedAttempts = 40;
    const { service, port } = baseRewriteService({ executor });
    const outcome = await service.rewriteNewsDraft(REWRITE_REQUEST);
    expect(outcome.kind).toBe('deferred');
    if (outcome.kind === 'deferred') {
      expect(outcome.reason).toBe('budget_denied');
      expect(outcome.attempts).toHaveLength(1);
      expect(outcome.attempts[0]?.outcome).toBe('quota_denied');
    }
    expect(port.calls).toHaveLength(0);
  });

  it('an open circuit breaker defers with zero provider calls', async () => {
    const executor = createFakeExecutor(NOW);
    executor.breakerOpen = true;
    const { service, port } = baseRewriteService({ executor });
    const outcome = await service.rewriteNewsDraft(REWRITE_REQUEST);
    expect(outcome.kind).toBe('deferred');
    if (outcome.kind === 'deferred') {
      expect(outcome.reason).toBe('circuit_open');
      expect(outcome.attempts).toHaveLength(0);
    }
    expect(port.calls).toHaveLength(0);
  });

  it('a transient failure tries the next model and logs the transport error name', async () => {
    const { service, port, logLines } = baseRewriteService({
      port: createFakeGeminiPort([
        { kind: 'transient', transportErrorName: 'TypeError' },
        { kind: 'ok', rawText: VALID_REWRITE_JSON },
      ]),
    });
    const outcome = await service.rewriteNewsDraft(REWRITE_REQUEST);
    expect(outcome.kind).toBe('rewritten');
    if (outcome.kind === 'rewritten') {
      expect(outcome.attempts).toHaveLength(2);
      expect(outcome.attempts[0]?.outcome).toBe('transient_failure');
      expect(outcome.attempts[0]?.modelId).toBe('gemini-3.5-flash-lite');
    }
    expect(port.calls).toHaveLength(2);
    // ADR-0070 §8: the attempt log names the transport failure — the
    // next failure is diagnosable from the log alone.
    const attemptLines = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry['msg'] === 'ai.rewrite.attempt');
    expect(attemptLines).toHaveLength(2);
    expect(attemptLines[0]?.['transportErrorName']).toBe('TypeError');
    expect(attemptLines[1]?.['transportErrorName']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Identity + time helpers
// ---------------------------------------------------------------------------

describe('rewrite identity and time helpers (ADR-0070 §4)', () => {
  it('rewrite run ids are deterministic and distinct from draft run ids', async () => {
    const a = await aiRunIdForRewriteAttempt('job-1', 1, 0);
    expect(a).toBe(await aiRunIdForRewriteAttempt('job-1', 1, 0));
    expect(a).not.toBe(await aiRunIdForRewriteAttempt('job-1', 1, 1));
    expect(a).not.toBe(await aiRunIdForRewriteAttempt('job-2', 1, 0));
    // Same job + generation as a news_draft run, but a different id:
    // the rewrite namespace can never collide with the draft run.
    expect(a).not.toBe(await aiRunIdForAttempt('job-1', 1));
    expect(a.startsWith('edai')).toBe(true);
  });

  it('rewrite job ids and idempotency keys are deterministic per draft', async () => {
    expect(await rewriteJobIdForDraft('edd_test')).toBe(await rewriteJobIdForDraft('edd_test'));
    expect(await rewriteJobIdForDraft('edd_test')).not.toBe(
      await rewriteJobIdForDraft('edd_other'),
    );
    expect(await editorialRewriteDraftIdempotencyKey('edd_test')).toBe(
      await editorialRewriteDraftIdempotencyKey('edd_test'),
    );
    expect(await editorialRewriteDraftIdempotencyKey('edd_test')).not.toBe(
      await editorialRewriteDraftIdempotencyKey('edd_other'),
    );
  });

  it('msUntilNextTehranMidnight returns a positive value in (0, 24h]', () => {
    const day = 24 * 60 * 60 * 1000;
    // 2023-11-14 23:59:30 Tehran — 30 s to midnight.
    expect(msUntilNextTehranMidnight(1_699_993_770_000)).toBe(30_000);
    // Exactly Tehran midnight — a full day away.
    expect(msUntilNextTehranMidnight(1_699_993_800_000)).toBe(day);
    // Midday Tehran: 12 h to midnight.
    const midday = msUntilNextTehranMidnight(1_699_950_600_000);
    expect(midday).toBeGreaterThan(0);
    expect(midday).toBeLessThanOrEqual(day);
    expect(midday).toBe(12 * 60 * 60 * 1000);
  });
});
