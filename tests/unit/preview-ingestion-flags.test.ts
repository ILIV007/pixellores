import { describe, expect, it } from 'vitest';
import wranglerJsoncRaw from '../../wrangler.jsonc?raw';

/**
 * ADR-0079 §3.1 — pin the committed preview ingestion flags. Ingestion
 * died silently Nov 22–28 because SOURCE_INGESTION_ENABLED and
 * EDITORIAL_ENABLED were "false" in every committed wrangler.jsonc and
 * a deploy wiped the live override that the Nov 21–22 polls ran under.
 * The ON state is committed in env.preview now; this test fails loudly
 * if a future edit re-disables the feed. The top-level (local) defaults
 * stay "false" — only the preview env is pinned ON.
 */
describe('preview ingestion flags (ADR-0079)', () => {
  function varsAfterPreview(): string {
    const previewAt = wranglerJsoncRaw.indexOf('"preview"');
    expect(previewAt).toBeGreaterThan(-1);
    return wranglerJsoncRaw.slice(previewAt);
  }

  function varsBeforePreview(): string {
    const previewAt = wranglerJsoncRaw.indexOf('"preview"');
    expect(previewAt).toBeGreaterThan(-1);
    return wranglerJsoncRaw.slice(0, previewAt);
  }

  it('env.preview enables source ingestion', () => {
    expect(varsAfterPreview()).toContain('"SOURCE_INGESTION_ENABLED": "true"');
  });

  it('env.preview enables the editorial drain', () => {
    expect(varsAfterPreview()).toContain('"EDITORIAL_ENABLED": "true"');
  });

  it('the local defaults stay disabled', () => {
    expect(varsBeforePreview()).toContain('"SOURCE_INGESTION_ENABLED": "false"');
    expect(varsBeforePreview()).toContain('"EDITORIAL_ENABLED": "false"');
  });
});
