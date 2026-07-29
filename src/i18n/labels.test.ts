import { describe, expect, it } from 'vitest';
import { translateOption, getContactLabels } from './labels.js';
import { CONTACT_LABELS } from '../contact.js';

describe('translateOption', () => {
  it('returns the canonical value unchanged for English', () => {
    expect(translateOption('en', 'Design', 'skill')).toBe('Design');
    expect(translateOption('en', 'Iran', 'country')).toBe('Iran');
  });

  it('translates known canonical values to Farsi', () => {
    expect(translateOption('fa', 'Design', 'skill')).toBe('طراحی');
    expect(translateOption('fa', 'Iran', 'country')).toBe('ایران');
    expect(translateOption('fa', 'Frontend Engineer', 'title')).toBe('مهندس فرانت‌اند');
  });

  it('falls back to the canonical value for unmapped/custom entries', () => {
    expect(translateOption('fa', 'Quantum Computing', 'skill')).toBe('Quantum Computing');
  });
});

describe('getContactLabels', () => {
  it('returns the canonical English labels for en', () => {
    expect(getContactLabels('en')).toBe(CONTACT_LABELS);
  });

  it('returns Farsi labels for fa without mutating the English map', () => {
    const faLabels = getContactLabels('fa');
    expect(faLabels.telegram).toBe('آیدی تلگرام');
    expect(faLabels.phone).toBe('شماره تلفن');
    expect(faLabels.email).toBe('ایمیل');
    expect(CONTACT_LABELS.telegram).toBe('Telegram ID');
  });
});
