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
  const csvPath = resolve(process.cwd(), process.argv[2] ?? 'group_members.csv');
  const raw = readFileSync(csvPath, { encoding: 'utf8' });
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) {
    console.error(`${csvPath} is empty or missing rows.`);
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

  for (const line of rows) {
    const cols = parseCsvLine(line);
    if (!cols[0]) continue;

    const telegramId = cols[0].trim();
    if (!telegramId) continue;

    const data = {
      username: cols[1]?.trim() || null,
      firstName: cols[2]?.trim() || null,
      lastName: cols[3]?.trim() || null,
      phone: cols[4]?.trim() || null,
    };

    const existing = await prisma.groupMember.findUnique({ where: { telegramId } });
    await prisma.groupMember.upsert({
      where: { telegramId },
      create: { telegramId, ...data },
      update: data,
    });

    if (existing) {
      updated += 1;
    } else {
      added += 1;
    }
  }

  const total = await prisma.groupMember.count();
  console.log(JSON.stringify({ csvPath, rowsProcessed: rows.length, added, updated, totalInGroupMemberTable: total }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
