import { describe, expect, it } from 'vitest';
import { findMentorMatches, normalizeSkills } from './matching.js';
import type { MenteeProfileLike, MentorProfileLike } from './matching.js';

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
});

describe('findMentorMatches', () => {
  const mentee: MenteeProfileLike = {
    name: 'Mentee',
    skillsNeeded: ['Backend', 'AI / ML'],
    experienceYears: 3,
    location: 'Berlin',
  };

  const baseMentor: Omit<MentorProfileLike, 'id' | 'name'> = {
    skills: [],
    experienceYears: 0,
    location: null,
    availability: true,
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

    // mentor 2: overlap(1)*3=3 + sameLocation(2) + sameExperience(2) = 7
    // mentor 3: overlap(2)*3=6 + farLocation(0) + farExperience(0) = 6
    // mentor 1: overlap(0)*3=0 + sameLocation(2) + sameExperience(2) = 4
    expect(results.map((m) => m.id)).toEqual([2, 3, 1]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(results[2].score);
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
      { id: 1, name: 'Mentor', ...baseMentor, skills: ['Backend'], experienceYears: 3 },
    ];
    const [match] = findMentorMatches(mentee0, mentors);
    expect(match.score).toBe(3); // overlap only, no experience bonus
  });

  it('returns an empty array when there are no mentors', () => {
    expect(findMentorMatches(mentee, [])).toEqual([]);
  });
});
