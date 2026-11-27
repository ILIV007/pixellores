import { describe, expect, it } from 'vitest';
import { GEMINI_API_BASE_URL_DEFAULT, parseAiConfig } from '../../src/shared/config/phase6';
import { GEMINI_API_DEFAULT_ORIGIN } from '../../src/adapters/ai/gemini-adapter';

/**
 * Phase 6 configuration (AI adapters, ADR-0041/ADR-0067) — offline unit
 * tests over parseAiConfig only. No secrets, no network.
 */

describe('parseAiConfig — Phase 6 flags and Gemini origin', () => {
  it('defaults the Gemini origin to the official endpoint and the flags to false', () => {
    const { config, result } = parseAiConfig({});
    expect(result.ok).toBe(true);
    expect(config.AI_ENABLED).toBe(false);
    expect(config.AI_GEMINI_ENABLED).toBe(false);
    // ADR-0070: the rewrite stage has its OWN flag, default OFF — the
    // ladder flag alone never opens it.
    expect(config.AI_GEMINI_REWRITE_ENABLED).toBe(false);
    expect(config.EVENT_RELATION_ENABLED).toBe(false);
    expect(config.GEMINI_API_BASE_URL).toBe('https://generativelanguage.googleapis.com');
    expect(config.GEMINI_API_BASE_URL).toBe(GEMINI_API_DEFAULT_ORIGIN);
    expect(GEMINI_API_BASE_URL_DEFAULT).toBe(GEMINI_API_DEFAULT_ORIGIN);
  });

  it('ADR-0070: parses AI_GEMINI_REWRITE_ENABLED independently of the ladder flag', () => {
    const { config, result } = parseAiConfig({
      AI_ENABLED: 'true',
      AI_GEMINI_ENABLED: 'false',
      AI_GEMINI_REWRITE_ENABLED: 'true',
    });
    expect(result.ok).toBe(true);
    expect(config.AI_GEMINI_REWRITE_ENABLED).toBe(true);
    expect(config.AI_GEMINI_ENABLED).toBe(false);
    const off = parseAiConfig({ AI_GEMINI_REWRITE_ENABLED: 'false' });
    expect(off.result.ok).toBe(true);
    expect(off.config.AI_GEMINI_REWRITE_ENABLED).toBe(false);
  });

  it('accepts a valid operator relay origin', () => {
    const { config, result } = parseAiConfig({
      GEMINI_API_BASE_URL: 'https://relay.example.com/gemini',
    });
    expect(result.ok).toBe(true);
    expect(config.GEMINI_API_BASE_URL).toBe('https://relay.example.com/gemini');
  });

  it('rejects invalid origins fail-closed and resolves to the official default', () => {
    for (const bad of [
      'http://relay.example.com',
      'https://user:pass@relay.example.com',
      'https://relay.example.com?x=1',
      'https://relay.example.com#frag',
      'not a url',
      'https://',
    ]) {
      const { config, result } = parseAiConfig({ GEMINI_API_BASE_URL: bad });
      expect(result.ok).toBe(false);
      expect(result.issues.map((issue) => issue.field)).toContain('GEMINI_API_BASE_URL');
      // The invalid value is never used: the resolved origin is the
      // official default (the jobs engine additionally fails closed on
      // result.ok === false — see ADR-0067).
      expect(config.GEMINI_API_BASE_URL).toBe(GEMINI_API_BASE_URL_DEFAULT);
    }
  });

  it('rejects invalid flag values instead of coercing them', () => {
    const { result } = parseAiConfig({ AI_GEMINI_ENABLED: 'yes' });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.field)).toContain('AI_GEMINI_ENABLED');
  });
});
