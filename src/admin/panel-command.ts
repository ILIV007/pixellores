/**
 * Slice 3 — the `/menu` argument parser (the R1.18.1 grammar discipline).
 *
 * Grammar (exactly one of):
 *   `/menu`           main panel
 *   `/menu mode`      mode screen
 *   `/menu cap`       cap screen
 *   `/menu event`     event screen
 *   `/menu schedule`  schedule screen (combined panel §4)
 *   `/menu drafts`    drafts & queue screen (combined panel §5)
 *   `/menu posts`     channel-post housekeeping screen (slice 6)
 *   `/menu manual`    manual-post screen (combined panel §7)
 *   `/menu ai`        AI & Soul screen (combined panel §8)
 *   `/menu settings`  settings screen (combined panel §9)
 *   `/menu stats`     stats screen (combined panel §10)
 *   `/menu admins`    admins screen (combined panel §11)
 *   `/menu debug`     debug/status screen (combined panel §12)
 *   `/menu help`      help screen (combined panel §13)
 *
 * Validation happens BEFORE any store access:
 * - The remainder must be a single token — newlines, control characters
 *   and extra tokens are `invalid`.
 *
 * The parser is pure: it never touches D1, never logs, and never echoes
 * the rejected input (the caller renders the static invalid-usage text).
 */
import type { PanelScreen } from './panel-strings';

export type MenuArgumentParse =
  | { readonly kind: 'main' }
  | { readonly kind: 'screen'; readonly screen: Exclude<PanelScreen, 'main'> }
  | { readonly kind: 'invalid' };

const MENU_SCREENS: readonly string[] = [
  'mode',
  'cap',
  'event',
  'schedule',
  'drafts',
  'posts',
  'manual',
  'ai',
  'settings',
  'stats',
  'admins',
  'debug',
  'help',
];

function isMenuScreen(value: string): value is Exclude<PanelScreen, 'main'> {
  return (MENU_SCREENS as readonly string[]).includes(value);
}

/**
 * Parse the WHOLE remainder of `/menu` (the router already stripped the
 * command token and its separator). `undefined` is the documented
 * no-argument main-panel form.
 */
export function parseMenuArgument(remainder: string | undefined): MenuArgumentParse {
  if (remainder === undefined || remainder === '') {
    return { kind: 'main' };
  }
  // Newlines / control characters can never be part of a valid argument —
  // they are a grammar failure, never a separator. (Checked by code point,
  // not by a control-character regex — the lint rule forbids the latter.)
  if (
    [...remainder].some((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return { kind: 'invalid' };
  }
  const tokens = remainder.split(/[ \t]+/u);
  if (tokens.length !== 1) {
    return { kind: 'invalid' };
  }
  const [screen] = tokens as [string | undefined];
  if (screen === undefined || !isMenuScreen(screen)) {
    return { kind: 'invalid' };
  }
  return { kind: 'screen', screen };
}
