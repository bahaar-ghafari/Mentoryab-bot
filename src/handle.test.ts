import { describe, expect, it } from 'vitest';
import { formatHtml, userHandle } from './handle';

describe('userHandle', () => {
  it('uses @username when present', () => {
    expect(userHandle({ username: 'john_doe', telegramId: '1' })).toBe('@john_doe');
  });
  it('falls back to a tg://user link with the escaped name', () => {
    expect(userHandle({ username: null, telegramId: '42' }, 'A <b> & C')).toBe('<a href="tg://user?id=42">A &lt;b&gt; &amp; C</a>');
  });
});

describe('formatHtml', () => {
  it('escapes values and template but keeps handles raw', () => {
    const handle = userHandle({ telegramId: '7' }, 'Sam');
    expect(formatHtml('{name} <{menteeHandle}> & x', { name: '<i>', menteeHandle: handle })).toBe(
      `&lt;i&gt; &lt;${handle}&gt; &amp; x`
    );
  });
});
