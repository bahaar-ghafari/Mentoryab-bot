import type { Locale } from './index.js';
import { CONTACT_LABELS, type ContactType } from '../contact.js';

// Display-only translations for canonical option values. The canonical English
// value (from options.ts) is always what gets stored/used as callback_data —
// these maps only change what text the button shows. Anything not found here
// (custom mentor-typed skills, unmapped values) falls back to the canonical
// value itself, which is why English needs no map.

const SKILL_LABELS_FA: Record<string, string> = {
  'Product management': 'مدیریت محصول',
  'Software engineering': 'مهندسی نرم‌افزار',
  'Data science': 'علم داده',
  Design: 'طراحی',
  'AI / ML': 'هوش مصنوعی / یادگیری ماشین',
  'Career coaching': 'مربی‌گری شغلی',
  Leadership: 'رهبری',
  Marketing: 'بازاریابی',
  Finance: 'امور مالی',
  Other: 'سایر',
};

const TITLE_LABELS_FA: Record<string, string> = {
  'Frontend Engineer': ' فرانت‌اند',
  'Backend Engineer': ' بک‌اند',
  'Full Stack Engineer': ' فول‌استک',
  'Mobile Engineer': 'مهندس موبایل',
  'Data Scientist': 'دیتاساینتیست',
  'ML Engineer': ' یادگیری ماشین',
  'DevOps Engineer': ' DevOps',
  'Product Manager': 'مدیر محصول',
  'UX/UI Designer': 'طراح UX/UI',
  'Engineering Manager': 'مدیر مهندسی',
  'CTO / VP Engineering': 'مدیر ارشد فناوری / معاون مهندسی',
  'Career Coach': 'مربی شغلی',
};

const COUNTRY_LABELS_FA: Record<string, string> = {
  Iran: 'ایران',
  'United States': 'ایالات متحده',
  'United Kingdom': 'بریتانیا',
  Canada: 'کانادا',
  Australia: 'استرالیا',
  Germany: 'آلمان',
  France: 'فرانسه',
  Netherlands: 'هلند',
  Sweden: 'سوئد',
  UAE: 'امارات متحده عربی',
  Turkey: 'ترکیه',
  India: 'هند',
  Pakistan: 'پاکستان',
  Other: 'سایر',
};

export const CONTACT_LABELS_FA: Record<ContactType, string> = {
  telegram: 'آیدی تلگرام',
  phone: 'شماره تلفن',
  email: 'ایمیل',
};

type OptionKind = 'skill' | 'title' | 'country';

const LABEL_MAPS: Record<Exclude<Locale, 'en'>, Record<OptionKind, Record<string, string>>> = {
  fa: {
    skill: SKILL_LABELS_FA,
    title: TITLE_LABELS_FA,
    country: COUNTRY_LABELS_FA,
  },
};

export function translateOption(locale: Locale, value: string, kind: OptionKind): string {
  if (locale === 'en') return value;
  return LABEL_MAPS[locale]?.[kind]?.[value] ?? value;
}

export function getContactLabels(locale: Locale): Record<ContactType, string> {
  return locale === 'en' ? CONTACT_LABELS : CONTACT_LABELS_FA;
}
