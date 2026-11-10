import { describe, it, expect } from 'vitest';
import { splitForTelegram } from './messages.js';

describe('splitForTelegram', () => {
  it('keeps short lists in one message', () => {
    expect(splitForTelegram('H', ['a', 'b'])).toEqual(['H\n\na\n\nb']);
  });
  it('splits long lists without exceeding the limit', () => {
    const entries = Array.from({ length: 50 }, (_, i) => `${i}`.padEnd(100, 'x'));
    const chunks = splitForTelegram('Header', entries, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 500)).toBe(true);
    expect(chunks.join('\n\n')).toContain(entries[49]);
  });
  it('hard-cuts a single oversized entry', () => {
    const chunks = splitForTelegram('H', ['y'.repeat(1200)], 500);
    expect(chunks.every((c) => c.length <= 500)).toBe(true);
  });
});
