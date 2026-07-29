// Canonical option values, shared by every locale. These are what gets stored in
// the database and used as callback_data, so they must never be translated —
// only their displayed button label is (see labels.ts). Keeping one shared list
// per option type is what lets a Farsi-onboarded mentor and an English-onboarded
// mentee still match on the same underlying skill/title/country value.

export const SKILL_OPTIONS = [
  'Product management',
  'Software engineering',
  'Data science',
  'Design',
  'AI / ML',
  'Career coaching',
  'Leadership',
  'Marketing',
  'Finance',
  'Other',
];

export const TITLE_OPTIONS = [
  'Frontend Engineer',
  'Backend Engineer',
  'Full Stack Engineer',
  'Mobile Engineer',
  'Data Scientist',
  'ML Engineer',
  'DevOps Engineer',
  'Product Manager',
  'UX/UI Designer',
  'Engineering Manager',
  'CTO / VP Engineering',
  'Career Coach',
];

export const COUNTRY_OPTIONS = [
  'Iran',
  'United States',
  'United Kingdom',
  'Canada',
  'Australia',
  'Germany',
  'France',
  'Netherlands',
  'Sweden',
  'UAE',
  'Turkey',
  'India',
  'Pakistan',
  'Other',
];
