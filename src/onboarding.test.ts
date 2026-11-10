import { describe, expect, it } from 'vitest';
import { ONBOARDING_STEPS, buildMentorData, calcExperienceYears } from './onboarding.js';

describe('mentor onboarding steps', () => {
  it('asks every question in order, ending with contact', () => {
    expect(ONBOARDING_STEPS.mentor).toEqual([
      'name', 'title', 'skills', 'stack', 'frameworks', 'experience', 'country', 'contact',
    ]);
  });

  it('walking the steps from the first one reaches finish only after contact', () => {
    const steps = ONBOARDING_STEPS.mentor;
    let index = 0;
    const visited: string[] = [];
    while (steps[index as number]) { visited.push(steps[index]); index += 1; }
    expect(visited).toHaveLength(8);
    expect(visited[0]).toBe('name');
    expect(visited[visited.length - 1]).toBe('contact');
  });
});

describe('calcExperienceYears', () => {
  it('counts years since the start year', () => {
    expect(calcExperienceYears('2016', new Date('2026-06-01'))).toBe(10);
  });
  it('never goes negative for a future year', () => {
    expect(calcExperienceYears('2099', new Date('2026-06-01'))).toBe(0);
  });
});

describe('buildMentorData', () => {
  const profile = {
    name: 'Mehdi Aryayi',
    title: 'Backend Developer',
    skills: 'Node.js, Docker , ',
    frameworks: 'Express,NestJS',
    experience: String(new Date().getFullYear() - 5),
    country: 'Germany',
  };

  it('builds a complete mentor record from a finished flow', () => {
    const data = buildMentorData(profile, { telegram: '@maryayi', email: 'm@example.com' }, 'fa');
    expect(data).toMatchObject({
      name: 'Mehdi Aryayi',
      title: 'Backend Developer',
      skills: ['Node.js', 'Docker'],
      frameworks: ['Express', 'NestJS'],
      experienceYears: 5,
      country: 'Germany',
      location: 'Germany',
      telegramContact: '@maryayi',
      emailContact: 'm@example.com',
      phoneContact: null,
      language: 'fa',
    });
    expect(data.contactMethods).toEqual(['💬 Telegram ID: @maryayi', '📧 Email: m@example.com']);
  });

  it('falls back to safe defaults when optional answers are missing', () => {
    const data = buildMentorData({}, undefined, 'en');
    expect(data).toMatchObject({
      name: 'Mentor', title: null, skills: [], frameworks: [], experienceYears: 0,
      country: null, location: null, contactMethods: [], telegramContact: null, language: 'en',
    });
  });

  it('prefers an explicit profile language over the UI language', () => {
    expect(buildMentorData({ language: 'English' }, undefined, 'fa').language).toBe('English');
  });
});
