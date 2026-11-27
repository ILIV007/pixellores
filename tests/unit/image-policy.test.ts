import { describe, expect, it } from 'vitest';
import {
  AI_IMAGE_BUDGET_KEY,
  AI_IMAGE_DAILY_ATTEMPT_CAP,
  AI_IMAGE_DAILY_NEURON_CAP,
  AI_IMAGE_DISCLOSURE_LINE,
  AI_IMAGE_DISCLOSURE_SEPARATOR,
  AI_IMAGE_FLUX_CONTENT_TYPE,
  AI_IMAGE_GENERATION_DEADLINE_MS,
  AI_IMAGE_MAX_BYTES,
  AI_IMAGE_MODEL_ALLOWLIST,
  AI_IMAGE_POLICY_VERSION,
  AI_IMAGE_PROMPT_VERSION,
  isAllowedImageModel,
} from '../../src/domain/ai/image-policy';

/**
 * AI image policy (ADR-0072) — pure versioned constants. The two
 * corrections to the owner-approved plan are pinned here: the retired
 * backups are NOT allowlisted, and the flux cost is 58 neurons/image
 * (not ~173).
 */
describe('AI image policy', () => {
  it('allow-lists exactly one model: flux-1-schnell as primary', () => {
    expect(AI_IMAGE_MODEL_ALLOWLIST).toHaveLength(1);
    const [primary] = AI_IMAGE_MODEL_ALLOWLIST;
    expect(primary?.modelId).toBe('@cf/black-forest-labs/flux-1-schnell');
    expect(primary?.role).toBe('primary');
    expect(primary?.steps).toBe(4);
  });

  it('prices one flux image at 58 neurons (4 tiles x 4.80 + 4 steps x 9.60 = 57.6, rounded up)', () => {
    const [primary] = AI_IMAGE_MODEL_ALLOWLIST;
    expect(primary?.neuronsPerImage).toBe(58);
  });

  it('records that flux takes no dimensions and no seed', () => {
    const [primary] = AI_IMAGE_MODEL_ALLOWLIST;
    expect(primary?.supportsDimensions).toBe(false);
    expect(primary?.supportsSeed).toBe(false);
  });

  it('refuses the plan’s retired backups (SDXL Lightning, DreamShaper — retired 2026-11-20)', () => {
    expect(isAllowedImageModel('@cf/bytedance/stable-diffusion-xl-lightning')).toBe(false);
    expect(isAllowedImageModel('@cf/lykon/dreamshaper-8-lcm')).toBe(false);
    expect(isAllowedImageModel('@cf/stabilityai/stable-diffusion-xl-base-1.0')).toBe(false);
    expect(isAllowedImageModel('@cf/black-forest-labs/flux-1-schnell')).toBe(true);
    expect(isAllowedImageModel('auto')).toBe(false);
    expect(isAllowedImageModel('')).toBe(false);
  });

  it('caps the separate image budget at 10 attempts / 2000 neurons per Tehran day', () => {
    expect(AI_IMAGE_BUDGET_KEY).toBe('workers-ai-image');
    expect(AI_IMAGE_DAILY_ATTEMPT_CAP).toBe(10);
    expect(AI_IMAGE_DAILY_NEURON_CAP).toBe(2000);
    // The attempt cap binds first (10 x 58 = 580 < 2000).
    expect(AI_IMAGE_DAILY_ATTEMPT_CAP * 58).toBeLessThan(AI_IMAGE_DAILY_NEURON_CAP);
  });

  it('pins the deadline, byte bound, disclosure and versions', () => {
    expect(AI_IMAGE_GENERATION_DEADLINE_MS).toBe(120_000);
    expect(AI_IMAGE_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(AI_IMAGE_DISCLOSURE_LINE).toBe('تصویر: ساختهٔ هوش مصنوعی');
    expect(AI_IMAGE_DISCLOSURE_SEPARATOR).toBe('\n\n');
    expect(AI_IMAGE_FLUX_CONTENT_TYPE).toBe('image/jpeg');
    expect(AI_IMAGE_POLICY_VERSION).toBe('ai-image-policy-v1');
    expect(AI_IMAGE_PROMPT_VERSION).toBe('pixel-image-prompt-v1');
  });
});
