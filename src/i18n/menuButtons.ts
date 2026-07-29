import { LOCALE_TEXTS, type Texts } from './index.js';

// Strip leading/trailing emoji, symbols, and whitespace so a stale reply-keyboard
// button cached on a user's device (from before an icon was added/changed) still
// matches the current label — Telegram won't refresh a shown keyboard until the
// bot sends a new one, so exact-string matching would silently break on any label
// tweak until every user happens to trigger a fresh keyboard.
export function normalizeButtonText(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim();
}

// A reply-keyboard button's label depends on the tapping user's language, which we
// don't know until we recognize the button — so match against every locale's label
// rather than requiring a DB lookup just to interpret which button was pressed.
export function matchesMenuButton(text: string, key: keyof Texts['startMenu']): boolean {
  const normalized = normalizeButtonText(text);
  return Object.values(LOCALE_TEXTS).some((loc) => normalizeButtonText(loc.startMenu[key]) === normalized);
}

export function menuButtonRegex(key: keyof Texts['startMenu']): RegExp {
  const variants = Object.values(LOCALE_TEXTS).map((loc) => normalizeButtonText(loc.startMenu[key]));
  const escaped = variants.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^[^\\p{L}\\p{N}]*(${escaped.join('|')})[^\\p{L}\\p{N}]*$`, 'iu');
}
