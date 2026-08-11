import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({ include: { mentorProfile: true } });
  const nonMentors = users
    .map((u) => ({ telegramId: u.telegramId, username: u.username, firstName: u.firstName, lastName: u.lastName, isRegistered: !!u.mentorProfile }))
    .filter((u) => !u.isRegistered);
  console.log(JSON.stringify({ count: nonMentors.length, users: nonMentors }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
