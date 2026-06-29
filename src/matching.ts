export type MentorProfileLike = {
  id: number;
  name: string;
  skills: string[];
  experienceYears: number;
  location: string | null;
  availability: boolean;
};

export type MenteeProfileLike = {
  name: string;
  skillsNeeded: string[];
  experienceYears: number | null;
  location: string | null;
};

export function normalizeSkills(skills: string[]): string[] {
  return skills
    .flatMap((skill) => skill.split(','))
    .map((skill) => skill.trim().toLowerCase())
    .filter(Boolean);
}

export function findMentorMatches(mentee: MenteeProfileLike, mentors: MentorProfileLike[]) {
  const menteeSkills = normalizeSkills(mentee.skillsNeeded);
  const menteeLocation = mentee.location?.trim().toLowerCase() || '';
  const menteeExperience = mentee.experienceYears ?? 0;

  return mentors
    .filter((mentor) => mentor.availability)
    .map((mentor) => {
      const mentorSkills = normalizeSkills(mentor.skills);
      const overlap = mentorSkills.filter((skill) => menteeSkills.includes(skill)).length;
      const locationBonus = menteeLocation && mentor.location?.trim().toLowerCase() === menteeLocation ? 2 : 0;
      const experienceBonus = menteeExperience > 0 ? Math.max(0, 2 - Math.abs(mentor.experienceYears - menteeExperience)) : 0;
      const score = overlap * 3 + locationBonus + experienceBonus;

      return { ...mentor, score };
    })
    .sort((a, b) => b.score - a.score);
}
