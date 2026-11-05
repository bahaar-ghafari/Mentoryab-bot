import { describe, expect, it } from 'vitest';
import { chunkMentions } from './mentions.js';

describe('chunkMentions', () => {
  it('keeps a small list in one chunk', () => {
    expect(chunkMentions(['@a', '@b'], 100)).toEqual([['@a', '@b']]);
  });

  it('returns nothing for no mentions', () => {
    expect(chunkMentions([], 100)).toEqual([]);
  });

  it('splits so no message exceeds the limit and keeps every mention in order', () => {
    const mentions = Array.from({ length: 500 }, (_, i) => `@user_number_${i}`);
    const body = 'x'.repeat(300);
    const chunks = chunkMentions(mentions, body.length, 1000);
    expect(chunks.flat()).toEqual(mentions);
    expect(chunks[0].join(' ').length + body.length + 2).toBeLessThanOrEqual(1000);
    for (const c of chunks.slice(1)) expect(c.join(' ').length).toBeLessThanOrEqual(1000);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
