import { describe, expect, it } from 'vitest';
import { normalizeButtonText, matchesMenuButton, menuButtonRegex } from './menuButtons.js';

describe('normalizeButtonText', () => {
  it('strips leading and trailing emoji/symbols and whitespace', () => {
    expect(normalizeButtonText('👥 Mentors List')).toBe('Mentors List');
    expect(normalizeButtonText('Mentors List ✅')).toBe('Mentors List');
    expect(normalizeButtonText('  Mentors List  ')).toBe('Mentors List');
  });

  it('leaves plain text without icons unchanged', () => {
    expect(normalizeButtonText('Mentors List')).toBe('Mentors List');
  });
});

describe('matchesMenuButton', () => {
  it('matches the current icon-prefixed label', () => {
    expect(matchesMenuButton('👥 Mentors List', 'adminMentors')).toBe(true);
  });

  it('still matches a stale button cached on a device from before an icon was added', () => {
    // Telegram doesn't refresh an already-shown reply keyboard until the bot sends
    // a new one, so a user can tap old plain-text buttons indefinitely.
    expect(matchesMenuButton('Mentors List', 'adminMentors')).toBe(true);
  });

  it('matches the Farsi label regardless of the tapping user\'s own stored language', () => {
    expect(matchesMenuButton('👥 لیست منتورها', 'adminMentors')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(matchesMenuButton('hello', 'adminMentors')).toBe(false);
  });
});

describe('menuButtonRegex', () => {
  it('matches both the icon-prefixed and stale plain-text label', () => {
    const regex = menuButtonRegex('joinMentors');
    expect(regex.test('🎓 Become Mentor')).toBe(true);
    expect(regex.test('Become Mentor')).toBe(true);
    expect(regex.test('🎓 منتور شوید')).toBe(true);
    expect(regex.test('unrelated text')).toBe(false);
  });
});
