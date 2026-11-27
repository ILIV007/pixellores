/**
 * Versioned AI IMAGE policy (ADR-0072).
 *
 * IMMUTABLE, VERSIONED ALLOWLIST — application policy over explicit model
 * IDs only, the same discipline as the text allowlist (./policy.ts).
 * The literal "auto" is never a model id and unknown models from any
 * provider catalog are never trusted. New candidates enter ONLY as a new
 * policy version after current public official model/pricing docs have
 * been verified (a public-doc fetch failure is NOT proof of eligibility).
 *
 * Verified 2026-11-27 (official Cloudflare docs + the installed
 * `@cloudflare/workers-types`):
 * - `@cf/black-forest-labs/flux-1-schnell` is ALIVE (not in the
 *   2026-11-20 retirement). Typed input is `{ prompt, steps? }` and the
 *   output is `{ image?: string }` (base64 JPEG). There is NO seed and
 *   NO width/height parameter — the docs examples passing `seed` are
 *   stale, and one observed live run had the seed rejected. The adapter
 *   passes `{ prompt, steps: 4 }` only.
 * - Cost (official pricing page): 4.80 neurons per 512x512 tile +
 *   9.60 per step. One 1024x1024 image at 4 steps = 4 x 4.80 +
 *   4 x 9.60 = 57.6 neurons — policy rounds to 58. (The build plan's
 *   "~173 neurons per image" is a misread: 173 is the number of flux
 *   images the 10,000/day free allowance buys, not the per-image cost.)
 * - The plan's named backups are DEAD: `@cf/bytedance/
 *   stable-diffusion-xl-lightning` and `@cf/lykon/dreamshaper-8-lcm`
 *   were retired 2026-11-20 and now return HTTP 410 / error 5028
 *   (Cloudflare changelog 2026-11-05). They are NOT in this allowlist.
 * - Cloudflare's named replacement, `@cf/black-forest-labs/
 *   flux-2-klein-9b`, takes a multipart editing input through the
 *   binding — no verified plain text-to-image call shape — so it is NOT
 *   a backup yet. The only other typed plain text-to-image models cost
 *   ~45x the primary (`lucid-origin`: 636/tile + 12/step = 2,592
 *   neurons per 1024x1024 image; `phoenix-1.0`: 2,160). A backup that
 *   costs 45x is not a backup. The ladder is a single model until a
 *   verified, affordable backup exists; the service still iterates the
 *   allowlist, so adding one later is a policy-version change.
 */

/** Version marker for the shipped image allowlist/caps set. */
export const AI_IMAGE_POLICY_VERSION = 'ai-image-policy-v1';

/** Version marker for the image prompt contract (see ./image-prompt.ts). */
export const AI_IMAGE_PROMPT_VERSION = 'pixel-image-prompt-v1';

/** Role of a model inside the image fallback ladder. */
export type AiImageModelRole = 'primary' | 'backup';

/** One immutable image-allowlist entry. */
export interface AiImageModelRecord {
  readonly modelId: string;
  readonly role: AiImageModelRole;
  /**
   * Estimated Cloudflare Neurons charged for ONE image at the pinned
   * call shape (see the per-model note). An ESTIMATE, never a billing
   * meter: the binding reports no neuron usage, so the app charges this
   * estimate at authorize time and the daily attempt cap is the binding
   * guard. Correct it from the first live measurement when it is wrong.
   */
  readonly neuronsPerImage: number;
  /** True when the model's typed input accepts width/height. */
  readonly supportsDimensions: boolean;
  /** True when the model's typed input accepts a seed. */
  readonly supportsSeed: boolean;
  /**
   * Pinned diffusion steps passed on every call (cost predictability:
   * the neuron estimate above assumes exactly this step count).
   */
  readonly steps: number;
}

/**
 * The ONLY image models this policy version may call, in ladder order.
 * A single model in v1 (see the header: the plan's backups retired
 * 2026-11-20 and no verified affordable backup exists yet).
 */
export const AI_IMAGE_MODEL_ALLOWLIST: readonly AiImageModelRecord[] = [
  {
    modelId: '@cf/black-forest-labs/flux-1-schnell',
    role: 'primary',
    // 4 tiles x 4.80 + 4 steps x 9.60 = 57.6, rounded up.
    neuronsPerImage: 58,
    supportsDimensions: false,
    supportsSeed: false,
    steps: 4,
  },
];

/** True iff the model id is in THIS policy version's image allowlist. */
export function isAllowedImageModel(modelId: string): boolean {
  return AI_IMAGE_MODEL_ALLOWLIST.some((model) => model.modelId === modelId);
}

/** The image budget's D1 key (budgets scope 'ai' — see ai-budget-store). */
export const AI_IMAGE_BUDGET_KEY = 'workers-ai-image';

/**
 * SEPARATE image budget (never the text budget): max image attempts per
 * Tehran day. 10/day covers the 6-9 no-photo posts the plan expects,
 * with headroom for one retry each.
 */
export const AI_IMAGE_DAILY_ATTEMPT_CAP = 10;

/**
 * SEPARATE image neuron budget per Tehran day (estimated neurons, see
 * above). 2,000/day allows ~34 flux images — the attempt cap binds
 * first (10 x 58 = 580). The cap exists so a future, pricier backup
 * cannot eat the shared 10,000/day free allowance the text path also
 * draws on.
 */
export const AI_IMAGE_DAILY_NEURON_CAP = 2_000;

/** TOTAL wall deadline for one image-generation service invocation. */
export const AI_IMAGE_GENERATION_DEADLINE_MS = 120_000;

/** Telegram photo-upload bound (Bot API 10.3): 10 MB by upload. */
export const AI_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** The AI-generated disclosure line appended to the caption (plan §7). */
export const AI_IMAGE_DISCLOSURE_LINE = 'تصویر: ساختهٔ هوش مصنوعی';

/** The separator between the rendered post text and the disclosure. */
export const AI_IMAGE_DISCLOSURE_SEPARATOR = '\n\n';

/** Image content type the flux adapter returns (base64 JPEG bytes). */
export const AI_IMAGE_FLUX_CONTENT_TYPE = 'image/jpeg';
