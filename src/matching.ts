export type MentorProfileLike = {
  id: number;
  name: string;
  title: string | null;
  skills: string[];
  experienceYears: number;
  location: string | null;
  availability: boolean;
  language: string;
};

export type MenteeProfileLike = {
  name: string;
  skillsNeeded: string[];
  experienceYears: number | null;
  location: string | null;
  language: string;
};

// Different names for the same underlying skill (e.g. "TS" and "TypeScript")
// that should be treated as one, not two separate skills. Distinct from
// SKILL_ABBREVIATIONS below, which maps shorthand to a job *title*, not a skill
// synonym — keys here must not collide with that map's keys.
const SKILL_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  reactjs: 'react',
  'react.js': 'react',
  'react js': 'react',
  vuejs: 'vue',
  'vue.js': 'vue',
  'vue js': 'vue',
  angularjs: 'angular',
  'angular.js': 'angular',
  nodejs: 'node.js',
  'node js': 'node.js',
  nextjs: 'next.js',
  'next js': 'next.js',
  nuxtjs: 'nuxt.js',
  postgres: 'postgresql',
  psql: 'postgresql',
  mongo: 'mongodb',
  py: 'python',
  golang: 'go',
};

export function canonicalizeSkill(skill: string): string {
  const key = skill.trim().toLowerCase();
  return SKILL_ALIASES[key] ?? key;
}

export function normalizeSkills(skills: string[]): string[] {
  return skills
    .flatMap((skill) => skill.split(','))
    .map((skill) => canonicalizeSkill(skill))
    .filter(Boolean);
}

// Known shorthand a mentee might type (e.g. "FF") that wouldn't otherwise match a
// mentor's canonical skill/title (e.g. "Frontend Engineer"). Keys and values are
// compared in already-normalized (trimmed, lowercased) form.
const SKILL_ABBREVIATIONS: Record<string, string> = {
  ff: 'frontend engineer',
  fe: 'frontend engineer',
  frontend: 'frontend engineer',
  be: 'backend engineer',
  backend: 'backend engineer',
  fs: 'full stack engineer',
  fullstack: 'full stack engineer',
  pm: 'product manager',
  em: 'engineering manager',
  ds: 'data scientist',
  ml: 'ai / ml',
  ai: 'ai / ml',
  ux: 'ux/ui designer',
  ui: 'ux/ui designer',
  devops: 'devops engineer',
  cto: 'cto / vp engineering',
  vp: 'cto / vp engineering',
};

// Expands each normalized term with any known abbreviation match, so a mentee
// searching for "ff" also matches mentors tagged/titled "Frontend Engineer".
// Keeps the original term too, since not every input is a known shorthand.
export function expandAbbreviations(normalizedTerms: string[]): string[] {
  const expanded = new Set(normalizedTerms);
  for (const term of normalizedTerms) {
    const mapped = SKILL_ABBREVIATIONS[term];
    if (mapped) expanded.add(mapped);
  }
  return [...expanded];
}

export function findMentorMatches(mentee: MenteeProfileLike, mentors: MentorProfileLike[]) {
  const menteeSkills = expandAbbreviations(normalizeSkills(mentee.skillsNeeded));
  const menteeLocation = mentee.location?.trim().toLowerCase() || '';
  const menteeExperience = mentee.experienceYears ?? 0;

  return mentors
    .filter((mentor) => mentor.availability)
    .map((mentor) => {
      const mentorSkills = normalizeSkills(mentor.skills);
      const mentorTitle = mentor.title ? normalizeSkills([mentor.title]) : [];
      const overlap =
        mentorSkills.filter((skill) => menteeSkills.includes(skill)).length +
        mentorTitle.filter((title) => menteeSkills.includes(title)).length;
      const locationBonus = menteeLocation && mentor.location?.trim().toLowerCase() === menteeLocation ? 2 : 0;
      const experienceBonus = menteeExperience > 0 ? Math.max(0, 2 - Math.abs(mentor.experienceYears - menteeExperience)) : 0;
      const languageBonus = mentor.language === mentee.language ? 2 : 0;
      const score = overlap * 3 + locationBonus + experienceBonus + languageBonus;

      return { ...mentor, score, overlap };
    })
    .sort((a, b) => b.score - a.score);
}
