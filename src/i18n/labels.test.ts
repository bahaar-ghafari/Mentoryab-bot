import { describe, expect, it } from 'vitest';
import { translateOption, getContactLabels } from './labels.js';
import { CONTACT_LABELS } from '../contact.js';

describe('translateOption', () => {
  it('returns the canonical value unchanged for English', () => {
    expect(translateOption('en', 'Design', 'skill')).toBe('Design');
  });

  it('translates known canonical values to Farsi', () => {
    expect(translateOption('fa', 'Design', 'skill')).toBe('طراحی');
    expect(translateOption('fa', 'Mobile Engineer', 'title')).toBe('مهندس موبایل');
  });

  it('falls back to the canonical value for unmapped/custom entries', () => {
    expect(translateOption('fa', 'Quantum Computing', 'skill')).toBe('Quantum Computing');
  });

  it('prefixes countries with a flag emoji, in every locale', () => {
    expect(translateOption('en', 'United States', 'country')).toBe('🇺🇸 United States');
    expect(translateOption('fa', 'United States', 'country')).toBe('🇺🇸 ایالات متحده');
  });

  it('uses the Sun and Lion emblem for Iran instead of its national flag', () => {
    expect(translateOption('en', 'Iran', 'country')).toBe('☀️🦁 Iran');
    expect(translateOption('fa', 'Iran', 'country')).toBe('☀️🦁 ایران');
  });

  it('falls back to the plain label for a country with no mapped flag', () => {
    expect(translateOption('en', 'Atlantis', 'country')).toBe('Atlantis');
  });
});

describe('getContactLabels', () => {
  it('returns the canonical English labels for en', () => {
    expect(getContactLabels('en')).toBe(CONTACT_LABELS);
  });

  it('returns Farsi labels for fa without mutating the English map', () => {
    const faLabels = getContactLabels('fa');
    expect(faLabels.telegram).toBe('💬 آیدی تلگرام');
    expect(faLabels.phone).toBe('📱 شماره تلفن');
    expect(faLabels.email).toBe('📧 ایمیل');
    expect(CONTACT_LABELS.telegram).toBe('💬 Telegram ID');
  });
});
