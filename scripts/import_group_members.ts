import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

dotenv.config();
const prisma = new PrismaClient();

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

async function main() {
  const csvPath = resolve(process.cwd(), 'group_members.csv');
  const raw = readFileSync(csvPath, { encoding: 'utf8' });
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) {
    console.error('group_members.csv is empty or missing rows.');
    process.exit(1);
  }

  const header = parseCsvLine(lines[0]);
  const expectedHeader = ['id', 'username', 'first_name', 'last_name', 'phone'];
  if (header.length < expectedHeader.length || !expectedHeader.every((col, idx) => header[idx] === col)) {
    console.warn('Warning: unexpected CSV header. Expected:', expectedHeader.join(','));
  }

  const rows = lines.slice(1);
  let added = 0;
  let updated = 0;
  const telegramIds: string[] = [];

  for (const line of rows) {
    const cols = parseCsvLine(line);
    if (!cols[0]) continue;

    const telegramId = cols[0].trim();
    if (!telegramId) continue;
    telegramIds.push(telegramId);

    const username = cols[1]?.trim() || undefined;
    const firstName = cols[2]?.trim() || undefined;
    const lastName = cols[3]?.trim() || undefined;

    const updateData: Record<string, string> = {};
    if (username) updateData.username = username;
    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;

    const existing = await prisma.user.findUnique({ where: { telegramId } });
    if (existing) {
      if (Object.keys(updateData).length > 0) {
        await prisma.user.update({ where: { telegramId }, data: updateData });
        updated += 1;
      }
    } else {
      await prisma.user.create({
        data: {
          telegramId,
          username,
          firstName,
          lastName,
          role: 'MENTEE',
          language: 'en',
        },
      });
      added += 1;
    }
  }

  const users = await prisma.user.findMany({
    where: { telegramId: { in: telegramIds } },
    include: { mentorProfile: true },
  });

  const nonMentors = users
    .filter((u) => !u.mentorProfile)
    .map((u) => ({ telegramId: u.telegramId, username: u.username, firstName: u.firstName, lastName: u.lastName }));

  console.log(JSON.stringify({
    imported: rows.length,
    added,
    updated,
    totalGroupUsersInDb: users.length,
    nonMentorsCount: nonMentors.length,
    nonMentors,
  }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
