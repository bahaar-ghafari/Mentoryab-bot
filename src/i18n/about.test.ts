import { describe, expect, it } from 'vitest';
import { LOCALE_TEXTS } from './index.js';

describe('mentor "About" field texts', () => {
  for (const [locale, t] of Object.entries(LOCALE_TEXTS)) {
    it(`${locale} defines the label, prompt and too-long message`, () => {
      expect(t.summary.about.length).toBeGreaterThan(0);
      expect((t.prompts as Record<string, string>).about.length).toBeGreaterThan(0);
      expect(t.messages.aboutTooLong.length).toBeGreaterThan(0);
    });
  }
});
