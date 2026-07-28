import { describe, expect, it } from 'vitest';
import { buildContactTypeKeyboard, renderContactMethodsSummary } from './contact.js';

describe('contact helpers', () => {
  it('renders contact methods summary correctly', () => {
    const summary = renderContactMethodsSummary({ telegram: '@user', email: 'me@example.com' });
    expect(summary).toBe('Telegram ID: @user, Email: me@example.com');
  });

  it('returns null when there are no contact methods', () => {
    expect(renderContactMethodsSummary({})).toBe(null);
    expect(renderContactMethodsSummary()).toBe(null);
  });

  it('builds contact type keyboard with no collected methods', () => {
    const keyboard = buildContactTypeKeyboard({}, true);
    expect(keyboard.inline_keyboard.flat().map((button) => button.text)).toEqual([
      'Telegram ID',
      'Phone Number',
      'Email',
      '← Back',
    ]);
  });

  it('builds contact type keyboard with collected methods and done button', () => {
    const keyboard = buildContactTypeKeyboard({ telegram: '@user', phone: '+123' }, true);
    expect(keyboard.inline_keyboard.flat().map((button) => button.text)).toEqual([
      'Email',
      '← Back',
      'Done ✅ (2)',
    ]);
  });
});
