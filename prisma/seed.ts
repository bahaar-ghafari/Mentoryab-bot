import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const skills = [
  // Frontend
  { name: 'React', title: 'Frontend' },
  { name: 'Vue', title: 'Frontend' },
  { name: 'Angular', title: 'Frontend' },
  { name: 'HTML/CSS', title: 'Frontend' },
  { name: 'JavaScript', title: 'Frontend' },
  { name: 'TypeScript', title: 'Frontend' },
  
  // Backend
  { name: 'Node.js', title: 'Backend' },
  { name: 'Python', title: 'Backend' },
  { name: 'Java', title: 'Backend' },
  { name: 'C#', title: 'Backend' },
  { name: 'PHP', title: 'Backend' },
  { name: 'Go', title: 'Backend' },
  { name: 'Rust', title: 'Backend' },
  
  // Databases
  { name: 'PostgreSQL', title: 'Database' },
  { name: 'MongoDB', title: 'Database' },
  { name: 'MySQL', title: 'Database' },
  { name: 'Redis', title: 'Database' },
  
  // DevOps/Cloud
  { name: 'Docker', title: 'DevOps' },
  { name: 'Kubernetes', title: 'DevOps' },
  { name: 'AWS', title: 'Cloud' },
  { name: 'Google Cloud', title: 'Cloud' },
  { name: 'Azure', title: 'Cloud' },
  
  // Mobile
  { name: 'React Native', title: 'Mobile' },
  { name: 'iOS', title: 'Mobile' },
  { name: 'Android', title: 'Mobile' },
  { name: 'Flutter', title: 'Mobile' },
  
  // Other
  { name: 'Product management', title: 'General' },
  { name: 'Data science', title: 'General' },
  { name: 'Design', title: 'General' },
  { name: 'AI / ML', title: 'General' },
  { name: 'Career coaching', title: 'General' },
  { name: 'Leadership', title: 'General' },
  { name: 'Marketing', title: 'General' },
  { name: 'Finance', title: 'General' },
];

async function main() {
  console.log('Seeding database with skills...');
  
  for (const skill of skills) {
    await prisma.skill.upsert({
      where: { name: skill.name },
      update: { title: skill.title },
      create: { name: skill.name, title: skill.title },
    });
  }
  
  console.log(`Seeded ${skills.length} skills`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
