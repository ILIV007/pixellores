/**
 * Claim-preservation guard for the Gemini rewrite (ADR-0070 §4).
 *
 * PURE, lexical, bounded — a numbers/dates check, NOT a truth engine.
 * Every digit-sequence in the rewritten headline + summary must occur in
 * the raw text (raw headline + raw summary + all claim texts). Names are
 * constrained by the rewrite prompt only — the ADR records that honestly.
 *
 * Digit folding reuses the ADR-0066 mapping (the fact-guard numbers
 * lens): Persian digits ۰-۹ and Arabic-Indic digits ٠-٩ fold to Latin
 * 0-9, the Arabic decimal separator ٫ folds to '.' and the thousand
 * separator ٬ folds to ',' — a 1:1 code-point map, so a folded token is
 * a substring of the folded raw text exactly when the raw text carries
 * the same digits in any script. Folding never rewrites stored text; it
 * only decides whether the number is observed.
 */

const NUMBER_TOKEN = /[\d۰-۹٠-٩]+(?:[.,٬٫][\d۰-۹٠-٩]+)*/gu;

/**
 * Fold digits for the guard's matching only (ADR-0066 mapping, reused).
 */
export function foldDigitsForRewriteGuard(text: string): string {
  return text.replace(/[\u0660-\u0669\u06F0-\u06F9\u066B\u066C]/g, (ch) => {
    const code = ch.codePointAt(0)!;
    if (code >= 0x0660 && code <= 0x0669) {
      return String(code - 0x0660);
    }
    if (code >= 0x06f0 && code <= 0x06f9) {
      return String(code - 0x06f0);
    }
    return code === 0x066b ? '.' : ',';
  });
}

/** All digit-sequences in a text, folded for comparison. */
export function rewriteDigitSequences(text: string): readonly string[] {
  return foldDigitsForRewriteGuard(text).match(NUMBER_TOKEN) ?? [];
}

/** Stable guard refusal codes (never raw text). */
export type RewriteGuardRefusalCode = 'empty_rewrite' | 'number_not_in_raw';

/**
 * Check a rewritten headline + summary against the raw fact basis.
 * Returns `ok: true` when every digit-sequence in the rewritten text
 * occurs in the folded raw text (raw headline + raw summary + claim
 * texts); otherwise the FIRST offending sequence is named (the folded
 * token only — never raw draft text) so the refusal stays log-safe.
 */
export function checkRewritePreservesNumbers(input: {
  readonly rawHeadlineFa: string;
  readonly rawSummaryFa: string;
  readonly rawClaimTexts: readonly string[];
  readonly rewrittenHeadlineFa: string;
  readonly rewrittenSummaryFa: string;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RewriteGuardRefusalCode; readonly token?: string } {
  if (
    input.rewrittenHeadlineFa.trim().length === 0 ||
    input.rewrittenSummaryFa.trim().length === 0
  ) {
    return { ok: false, code: 'empty_rewrite' };
  }
  const rawFolded = foldDigitsForRewriteGuard(
    [input.rawHeadlineFa, input.rawSummaryFa, ...input.rawClaimTexts].join('\n'),
  );
  const rewritten = `${input.rewrittenHeadlineFa}\n${input.rewrittenSummaryFa}`;
  for (const token of rewriteDigitSequences(rewritten)) {
    if (!rawFolded.includes(token)) {
      return { ok: false, code: 'number_not_in_raw', token };
    }
  }
  return { ok: true };
}

/**
 * Check a rewritten inbound post against the owner's raw text (ADR-0073
 * §1): the single-text twin of `checkRewritePreservesNumbers`. Every
 * digit-sequence in the rewritten text must occur in the folded raw
 * text; the FIRST offending sequence is named (the folded token only —
 * never raw post text) so the refusal stays log-safe.
 */
export function checkInboundRewritePreservesNumbers(input: {
  readonly rawText: string;
  readonly rewrittenText: string;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RewriteGuardRefusalCode; readonly token?: string } {
  if (input.rewrittenText.trim().length === 0) {
    return { ok: false, code: 'empty_rewrite' };
  }
  const rawFolded = foldDigitsForRewriteGuard(input.rawText);
  for (const token of rewriteDigitSequences(input.rewrittenText)) {
    if (!rawFolded.includes(token)) {
      return { ok: false, code: 'number_not_in_raw', token };
    }
  }
  return { ok: true };
}
