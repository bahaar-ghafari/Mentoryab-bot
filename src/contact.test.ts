import { describe, expect, it } from 'vitest';
import { buildContactTypeKeyboard, isValidEmail, renderContactMethodsSummary } from './contact.js';

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

describe('isValidEmail', () => {
  it('accepts well-formed email addresses', () => {
    expect(isValidEmail('name@example.com')).toBe(true);
    expect(isValidEmail('first.last+tag@sub.example.co')).toBe(true);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(isValidEmail('  name@example.com  ')).toBe(true);
  });

  it('rejects strings without an @ or a domain dot', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('name@example')).toBe(false);
    expect(isValidEmail('@example.com')).toBe(false);
    expect(isValidEmail('name@.com')).toBe(false);
  });

  it('rejects strings containing spaces', () => {
    expect(isValidEmail('name @example.com')).toBe(false);
    expect(isValidEmail('name@ example.com')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidEmail('')).toBe(false);
  });
});
