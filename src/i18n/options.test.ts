import { describe, it, expect } from 'vitest';
import { STACK_OPTIONS, TECH_SUGGESTIONS } from './options.js';
import { translateOption } from './labels.js';

describe('stack options', () => {
  it('has suggestions and a Farsi label for every stack', () => {
    for (const stack of STACK_OPTIONS) {
      expect(TECH_SUGGESTIONS[stack]?.length).toBeGreaterThan(0);
      expect(translateOption('fa', stack, 'stack')).not.toBe(stack);
    }
  });

  it('keeps suggestion callback data under Telegram\'s 64-byte limit', () => {
    for (const list of Object.values(TECH_SUGGESTIONS)) {
      for (const tech of list) expect(Buffer.byteLength(`toggle_fw:${tech}`)).toBeLessThanOrEqual(64);
    }
  });
});
