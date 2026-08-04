import { describe, expect, it } from 'vitest';
import {
  buildContactTypeKeyboard,
  isValidEmail,
  isValidPhone,
  isValidTelegramUsername,
  normalizeTelegramUsername,
  renderContactMethodsSummary,
} from './contact.js';

describe('contact helpers', () => {
  it('renders contact methods summary correctly', () => {
    const summary = renderContactMethodsSummary({ telegram: '@user', email: 'me@example.com' });
    expect(summary).toBe('💬 Telegram ID: @user, 📧 Email: me@example.com');
  });

  it('returns null when there are no contact methods', () => {
    expect(renderContactMethodsSummary({})).toBe(null);
    expect(renderContactMethodsSummary()).toBe(null);
  });

  it('builds contact type keyboard with no collected methods', () => {
    const keyboard = buildContactTypeKeyboard({}, true);
    expect(keyboard.inline_keyboard.flat().map((button) => button.text)).toEqual([
      '💬 Telegram ID',
      '📱 Phone Number',
      '📧 Email',
      '← Back',
    ]);
  });

  it('still shows every type once collected (marked with a checkmark), so any of them can be changed', () => {
    const keyboard = buildContactTypeKeyboard({ telegram: '@user', phone: '+123' }, true);
    expect(keyboard.inline_keyboard.flat().map((button) => button.text)).toEqual([
      '✅ 💬 Telegram ID',
      '✅ 📱 Phone Number',
      '📧 Email',
      '← Back',
      'Done ✅ (2)',
    ]);
  });

  it('accepts custom labels and ui strings for a translated keyboard', () => {
    const faLabels = { telegram: 'آیدی تلگرام', phone: 'شماره تلفن', email: 'ایمیل' };
    const keyboard = buildContactTypeKeyboard({}, true, faLabels, { back: '← بازگشت', done: 'انجام شد' });
    expect(keyboard.inline_keyboard.flat().map((button) => button.text)).toEqual([
      'آیدی تلگرام',
      'شماره تلفن',
      'ایمیل',
      '← بازگشت',
    ]);
  });

  it('renders the summary using custom labels when provided', () => {
    const faLabels = { telegram: 'آیدی تلگرام', phone: 'شماره تلفن', email: 'ایمیل' };
    const summary = renderContactMethodsSummary({ telegram: '@user' }, faLabels);
    expect(summary).toBe('آیدی تلگرام: @user');
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

describe('isValidTelegramUsername', () => {
  it('accepts a well-formed username, with or without a leading @', () => {
    expect(isValidTelegramUsername('john_doe')).toBe(true);
    expect(isValidTelegramUsername('@john_doe')).toBe(true);
  });

  it('rejects usernames that are too short, start with a digit, or contain invalid characters', () => {
    expect(isValidTelegramUsername('abcd')).toBe(false);
    expect(isValidTelegramUsername('1abcde')).toBe(false);
    expect(isValidTelegramUsername('john doe')).toBe(false);
    expect(isValidTelegramUsername('john-doe')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidTelegramUsername('')).toBe(false);
    expect(isValidTelegramUsername('@')).toBe(false);
  });
});

describe('normalizeTelegramUsername', () => {
  it('adds a leading @ when missing', () => {
    expect(normalizeTelegramUsername('john_doe')).toBe('@john_doe');
  });

  it('does not double up an existing @', () => {
    expect(normalizeTelegramUsername('@john_doe')).toBe('@john_doe');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeTelegramUsername('  john_doe  ')).toBe('@john_doe');
  });
});

describe('isValidPhone', () => {
  it('accepts common phone formats', () => {
    expect(isValidPhone('+1234567890')).toBe(true);
    expect(isValidPhone('+1 (234) 567-890')).toBe(true);
    expect(isValidPhone('09123456789')).toBe(true);
  });

  it('rejects too few or too many digits', () => {
    expect(isValidPhone('12345')).toBe(false);
    expect(isValidPhone('1234567890123456')).toBe(false);
  });

  it('rejects letters or other invalid characters', () => {
    expect(isValidPhone('call-me-maybe')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidPhone('')).toBe(false);
  });
});
