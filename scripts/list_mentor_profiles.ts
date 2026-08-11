import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

dotenv.config();
const prisma = new PrismaClient();

async function main() {
  const mentorProfiles = await prisma.mentorProfile.findMany({ include: { user: true } });
  const csvRaw = readFileSync(resolve(process.cwd(), 'group_members.csv'), 'utf8');
  const csvIds = new Set(csvRaw.split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(',')[0].trim()));
  console.log(JSON.stringify({ mentorProfiles: mentorProfiles.map((p) => ({ telegramId: p.user.telegramId, username: p.user.username, firstName: p.user.firstName, lastName: p.user.lastName, title: p.title, skills: p.skills, frameworks: p.frameworks, contactMethods: p.contactMethods, approved: p.approved, inCsv: csvIds.has(p.user.telegramId) })), count: mentorProfiles.length }, null, 2));
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
