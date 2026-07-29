import { texts as en } from './en.js';
import { texts as fa } from './fa.js';

export type Locale = 'en' | 'fa';
export type Texts = Omit<typeof en, 'locale'> & { locale: Locale };

export const LOCALE_TEXTS: Record<Locale, Texts> = { en, fa };

export function getTexts(locale?: string | null): Texts {
  return locale === 'fa' ? fa : en;
}

export function isLocale(value: string | null | undefined): value is Locale {
  return value === 'en' || value === 'fa';
}

export const LANGUAGE_CHOICES: Array<{ code: Locale; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'fa', label: 'فارسی' },
];
