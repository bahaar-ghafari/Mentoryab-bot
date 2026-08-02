import { describe, expect, it } from 'vitest';
import { findMentorMatches, normalizeSkills, expandAbbreviations, canonicalizeSkill } from './matching.js';
import type { MenteeProfileLike, MentorProfileLike } from './matching.js';

describe('canonicalizeSkill', () => {
  it('maps known synonyms to one canonical form', () => {
    expect(canonicalizeSkill('TS')).toBe('typescript');
    expect(canonicalizeSkill('TypeScript')).toBe('typescript');
    expect(canonicalizeSkill('ReactJS')).toBe('react');
    expect(canonicalizeSkill('React.js')).toBe('react');
  });

  it('leaves unmapped terms unchanged (just trimmed/lowercased)', () => {
    expect(canonicalizeSkill('  Leadership  ')).toBe('leadership');
  });
});

describe('normalizeSkills', () => {
  it('splits comma-separated entries, trims, and lowercases', () => {
    expect(normalizeSkills([' Design, Leadership ', 'AI / ML'])).toEqual([
      'design',
      'leadership',
      'ai / ml',
    ]);
  });

  it('drops empty entries', () => {
    expect(normalizeSkills(['', ' , ', 'Backend'])).toEqual(['backend']);
  });

  it('returns an empty array for no input', () => {
    expect(normalizeSkills([])).toEqual([]);
  });

  it('treats TS and TypeScript as the same skill', () => {
    expect(normalizeSkills(['TS'])).toEqual(normalizeSkills(['TypeScript']));
  });
});

describe('findMentorMatches', () => {
  const mentee: MenteeProfileLike = {
    name: 'Mentee',
    skillsNeeded: ['Backend', 'AI / ML'],
    experienceYears: 3,
    location: 'Berlin',
    language: 'en',
  };

  const baseMentor: Omit<MentorProfileLike, 'id' | 'name'> = {
    title: null,
    skills: [],
    experienceYears: 0,
    location: null,
    availability: true,
    language: 'en',
  };

  it('excludes mentors who are not available', () => {
    const mentors: MentorProfileLike[] = [
      { id: 1, name: 'Busy Mentor', ...baseMentor, skills: ['Backend'], availability: false },
    ];
    expect(findMentorMatches(mentee, mentors)).toEqual([]);
  });

  it('ranks mentors by skill overlap, location, and experience closeness', () => {
    const mentors: MentorProfileLike[] = [
      { id: 1, name: 'No overlap', ...baseMentor, skills: ['Design'], experienceYears: 3, location: 'Berlin' },
      { id: 2, name: 'Partial overlap, same city', ...baseMentor, skills: ['Backend'], experienceYears: 3, location: 'Berlin' },
      { id: 3, name: 'Full overlap, far away', ...baseMentor, skills: ['Backend', 'AI / ML'], experienceYears: 10, location: 'Tokyo' },
    ];

    const results = findMentorMatches(mentee, mentors);

    // All mentors share the mentee's language (+2 each), so relative order is
    // unaffected by that bonus:
    // mentor 2: overlap(1)*3=3 + sameLocation(2) + sameExperience(2) + language(2) = 9
    // mentor 3: overlap(2)*3=6 + farLocation(0) + farExperience(0) + language(2) = 8
    // mentor 1: overlap(0)*3=0 + sameLocation(2) + sameExperience(2) + language(2) = 6
    expect(results.map((m) => m.id)).toEqual([2, 3, 1]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(results[2].score);
  });

  it('awards a bonus when mentor and mentee share the same language', () => {
    const mentors: MentorProfileLike[] = [
      { id: 1, name: 'Same language', ...baseMentor, skills: ['Backend'], language: 'en' },
      { id: 2, name: 'Different language', ...baseMentor, skills: ['Backend'], language: 'fa' },
    ];
    const results = findMentorMatches(mentee, mentors);
    expect(results.map((m) => m.id)).toEqual([1, 2]);
    expect(results[0].score).toBe(results[1].score + 2);
  });

  it('is case-insensitive when matching skills', () => {
    const mentors: MentorProfileLike[] = [
      { id: 1, name: 'Mentor', ...baseMentor, skills: ['BACKEND', 'ai / ml'] },
    ];
    const [match] = findMentorMatches(mentee, mentors);
    expect(match.score).toBeGreaterThan(0);
  });

  it('does not award experience bonus when mentee has no experience recorded', () => {
    const mentee0: MenteeProfileLike = { ...mentee, experienceYears: 0 };
    const mentors: MentorProfileLike[] = [
      // Different language than the mentee, isolating this assertion from the language bonus
      { id: 1, name: 'Mentor', ...baseMentor, skills: ['Backend'], experienceYears: 3, language: 'fa' },
    ];
    const [match] = findMentorMatches(mentee0, mentors);
    expect(match.score).toBe(3); // overlap only, no experience or language bonus
  });

  it('returns an empty array when there are no mentors', () => {
    expect(findMentorMatches(mentee, [])).toEqual([]);
  });

  it('matches on mentor title, not just skills', () => {
    const menteeLookingForFrontend: MenteeProfileLike = { ...mentee, skillsNeeded: ['Frontend Engineer'] };
    const mentors: MentorProfileLike[] = [
      { id: 1, name: 'Has the title, no matching skill', ...baseMentor, title: 'Frontend Engineer', skills: ['Leadership'] },
      { id: 2, name: 'No title, no matching skill', ...baseMentor, title: null, skills: ['Leadership'] },
    ];
    const results = findMentorMatches(menteeLookingForFrontend, mentors);
    expect(results[0].id).toBe(1);
    expect(results[0].overlap).toBe(1);
    expect(results[1].overlap).toBe(0);
  });

  it('exposes overlap so callers can distinguish a real skill/title match from a bonus-only match', () => {
    const mentors: MentorProfileLike[] = [
      { id: 1, name: 'No skill overlap, same city', ...baseMentor, skills: ['Design'], location: 'Berlin' },
    ];
    const [match] = findMentorMatches(mentee, mentors);
    expect(match.overlap).toBe(0);
    expect(match.score).toBeGreaterThan(0); // location/language bonuses still apply
  });

  it('matches a mentee searching "TypeScript" against a mentor who listed "TS"', () => {
    const menteeWantsTypeScript: MenteeProfileLike = { ...mentee, skillsNeeded: ['TypeScript'] };
    const mentors: MentorProfileLike[] = [
      { id: 1, name: 'Lists TS', ...baseMentor, skills: ['TS'] },
    ];
    const [match] = findMentorMatches(menteeWantsTypeScript, mentors);
    expect(match.overlap).toBe(1);
  });
});

describe('expandAbbreviations', () => {
  it('adds the canonical term for a known abbreviation', () => {
    expect(expandAbbreviations(['ff'])).toEqual(['ff', 'frontend engineer']);
  });

  it('keeps unknown terms unchanged with no expansion', () => {
    expect(expandAbbreviations(['react'])).toEqual(['react']);
  });

  it('deduplicates when the expansion is already present', () => {
    expect(expandAbbreviations(['fe', 'frontend engineer'])).toEqual(['fe', 'frontend engineer']);
  });
});
