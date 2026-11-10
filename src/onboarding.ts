import { CONTACT_LABELS, type ContactType } from './contact.js';

export const ONBOARDING_STEPS = {
  mentor: ['name', 'title', 'skills', 'stack', 'frameworks', 'experience', 'country', 'contact'],
  mentee: ['name', 'goals', 'skills', 'experience', 'country'],
} as const;

export function calcExperienceYears(startYearStr: string, now: Date = new Date()): number {
  const year = Number(startYearStr);
  return Math.max(0, now.getFullYear() - year);
}

function splitList(value: string | undefined): string[] {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Builds the MentorProfile fields saved when mentor onboarding finishes.
// Values are stored in canonical English regardless of the UI language.
export function buildMentorData(
  profile: Record<string, string>,
  contactMethods: Partial<Record<ContactType, string>> | undefined,
  uiLanguage: string
) {
  const experienceYears = profile.experience ? calcExperienceYears(profile.experience) : 0;
  const contacts = (Object.entries(contactMethods ?? {}) as Array<[ContactType, string]>)
    .map(([type, value]) => `${CONTACT_LABELS[type]}: ${value}`);
  return {
    name: profile.name || 'Mentor',
    title: profile.title || null,
    skills: splitList(profile.skills),
    frameworks: splitList(profile.frameworks),
    experienceYears,
    country: profile.country || null,
    location: profile.country || null,
    contactMethods: contacts,
    telegramContact: contactMethods?.telegram || null,
    phoneContact: contactMethods?.phone || null,
    emailContact: contactMethods?.email || null,
    language: profile.language || uiLanguage,
  };
}
