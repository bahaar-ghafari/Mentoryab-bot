import dotenv from 'dotenv';
import express from 'express';
import TelegramBot, { type Message } from 'node-telegram-bot-api';
import { PrismaClient } from '@prisma/client';
import { findMentorMatches } from './matching.js';
import { texts } from './i18n/en.js';

const STATE_KEY = 'state';
const ONBOARDING_STEPS = {
  mentor: ['name', 'skills', 'experience', 'location', 'contact'],
  mentee: ['name', 'goals', 'skills', 'experience', 'location'],
} as const;

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const port = Number(process.env.PORT || 3000);
const token = process.env.TELEGRAM_BOT_TOKEN;

function format(text: string, values: Record<string, string | number> = {}) {
  return text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

function buildSkillKeyboard() {
  return {
    keyboard: texts.skillOptions.map((skill) => [{ text: skill }]).concat([[{ text: 'Other' }]]),
    one_time_keyboard: true,
    resize_keyboard: true,
  };
}

function buildMainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: texts.startMenu.joinMentors }, { text: texts.startMenu.needMentor }],
      [{ text: texts.startMenu.match }, { text: texts.startMenu.busy }],
      [{ text: texts.startMenu.available }, { text: texts.startMenu.help }],
    ],
    resize_keyboard: true,
  };
}

if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is required');
}

const bot = new TelegramBot(token, { polling: true });

const userStates = new Map<string, { role: 'mentor' | 'mentee'; stepIndex: number; profile: Record<string, string> }>();
const pendingRequests = new Map<string, { mentorId: number; menteeId: number }>();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

bot.onText(/\/start/, async (msg: Message) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);

  await prisma.user.upsert({
    where: { telegramId },
    update: {
      firstName: msg.from?.first_name || null,
      lastName: msg.from?.last_name || null,
      username: msg.from?.username || null,
    },
    create: {
      telegramId,
      firstName: msg.from?.first_name || null,
      lastName: msg.from?.last_name || null,
      username: msg.from?.username || null,
    },
  });

  await bot.sendMessage(chatId, `${texts.welcome}\n\n${texts.chooseRole}`, {
    reply_markup: buildMainMenuKeyboard(),
  });
});

const startMentorOnboarding = async (msg: Message) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  userStates.set(telegramId, { role: 'mentor', stepIndex: 0, profile: {} });
  await bot.sendMessage(chatId, texts.mentorStart);
};

const startMenteeOnboarding = async (msg: Message) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  userStates.set(telegramId, { role: 'mentee', stepIndex: 0, profile: {} });
  await bot.sendMessage(chatId, texts.menteeStart);
};

bot.onText(/^Join$/i, startMentorOnboarding);
bot.onText(/^Need$/i, startMenteeOnboarding);

bot.onText(/\/mentor/, startMentorOnboarding);

bot.onText(/\/mentee/, async (msg: Message) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  userStates.set(telegramId, { role: 'mentee', stepIndex: 0, profile: {} });
  await bot.sendMessage(chatId, texts.menteeStart);
});

const handleMatchRequest = async (msg: Message) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    include: { menteeProfile: true },
  });

  if (!user?.menteeProfile) {
    await bot.sendMessage(chatId, texts.messages.completeMenteeProfile);
    return;
  }

  const mentors = await prisma.mentorProfile.findMany({
    where: { availability: true },
  });

  const matches = findMentorMatches(
    {
      name: user.menteeProfile.name,
      skillsNeeded: user.menteeProfile.skillsNeeded,
      experienceYears: user.menteeProfile.experienceYears,
      location: user.menteeProfile.location,
    },
    mentors.map((mentor) => ({
      id: mentor.id,
      name: mentor.name,
      skills: mentor.skills,
      experienceYears: mentor.experienceYears,
      location: mentor.location,
      availability: mentor.availability,
    }))
  );

  if (!matches.length) {
    await bot.sendMessage(chatId, texts.messages.noMentorsAvailable);
    return;
  }

  const topMatches = matches.slice(0, 3);
  let reply = texts.messages.topMentorMatches + '\n';
  for (const mentor of topMatches) {
    reply += `\n${mentor.name} — skills: ${mentor.skills.join(', ')} — experience: ${mentor.experienceYears} years — location: ${mentor.location || 'N/A'}\n`;
  }

  await bot.sendMessage(chatId, reply);
};

const handleSetBusy = async (msg: Message) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true } });

  if (!user?.mentorProfile) {
    await bot.sendMessage(chatId, texts.messages.needMentorProfile);
    return;
  }

  await prisma.mentorProfile.update({
    where: { id: user.mentorProfile.id },
    data: { availability: false },
  });

  await bot.sendMessage(chatId, texts.messages.busySet);
};

const handleSetAvailable = async (msg: Message) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true } });

  if (!user?.mentorProfile) {
    await bot.sendMessage(chatId, texts.messages.needMentorProfile);
    return;
  }

  await prisma.mentorProfile.update({
    where: { id: user.mentorProfile.id },
    data: { availability: true },
  });

  await bot.sendMessage(chatId, texts.messages.availableSet);
};

const handleHelp = async (msg: Message) => {
  await bot.sendMessage(msg.chat.id, texts.messages.helpText);
};

bot.onText(/\/match/, handleMatchRequest);
bot.onText(/^Match$/i, handleMatchRequest);

bot.onText(/\/busy/, handleSetBusy);
bot.onText(/^Busy$/i, handleSetBusy);

bot.onText(/\/available/, handleSetAvailable);
bot.onText(/^Available$/i, handleSetAvailable);

bot.onText(/\/help/, handleHelp);
bot.onText(/^Help$/i, handleHelp);

bot.onText(/\/request_(\d+)/, async (msg: Message, match: RegExpExecArray | null) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    include: { menteeProfile: true },
  });

  if (!user?.menteeProfile) {
    await bot.sendMessage(chatId, texts.messages.completeMenteeProfile);
    return;
  }

  const mentors = await prisma.mentorProfile.findMany({
    where: { availability: true },
  });

  const matches = findMentorMatches(
    {
      name: user.menteeProfile.name,
      skillsNeeded: user.menteeProfile.skillsNeeded,
      experienceYears: user.menteeProfile.experienceYears,
      location: user.menteeProfile.location,
    },
    mentors.map((mentor) => ({
      id: mentor.id,
      name: mentor.name,
      skills: mentor.skills,
      experienceYears: mentor.experienceYears,
      location: mentor.location,
      availability: mentor.availability,
    }))
  );

  if (!matches.length) {
    await bot.sendMessage(chatId, texts.messages.noMentorsAvailable);
    return;
  }

  const topMatches = matches.slice(0, 3);
  let reply = 'Top mentor matches:\n';
  for (const mentor of topMatches) {
    reply += `\n${mentor.name} — skills: ${mentor.skills.join(', ')} — experience: ${mentor.experienceYears} years — location: ${mentor.location || 'N/A'}\nSend /request_${mentor.id} to request this mentor.`;
  }

  await bot.sendMessage(chatId, reply);
});

bot.onText(/\/request_(\d+)/, async (msg: Message, match: RegExpExecArray | null) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const mentorId = Number(match?.[1]);

  const mentee = await prisma.user.findUnique({
    where: { telegramId },
    include: { menteeProfile: true },
  });

  if (!mentee?.menteeProfile) {
    await bot.sendMessage(chatId, texts.messages.completeMenteeProfile);
    return;
  }

  const mentor = await prisma.mentorProfile.findUnique({ where: { id: mentorId } });
  if (!mentor) {
    await bot.sendMessage(chatId, texts.messages.mentorNotFound);
    return;
  }

  const mentorUser = await prisma.user.findUnique({ where: { id: mentor.userId } });
  if (!mentorUser) {
    await bot.sendMessage(chatId, texts.messages.mentorUserNotFound);
    return;
  }

  pendingRequests.set(`${mentorUser.telegramId}:${mentee.id}`, { mentorId: mentor.id, menteeId: mentee.id });
  await bot.sendMessage(chatId, format(texts.messages.requestSent, { mentorName: mentor.name }));
  await bot.sendMessage(
    Number(mentorUser.telegramId),
    format(texts.messages.requestNew, {
      menteeName: mentee.menteeProfile.name,
      menteeId: mentee.id,
    })
  );
});

bot.onText(/\/accept_(\d+)/, async (msg: Message, match: RegExpExecArray | null) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const menteeId = Number(match?.[1]);

  const mentorUser = await prisma.user.findUnique({ where: { telegramId } });
  if (!mentorUser) {
    return;
  }

  const requestKey = `${telegramId}:${menteeId}`;
  const request = pendingRequests.get(requestKey);
  if (!request) {
    await bot.sendMessage(chatId, texts.messages.noPendingRequest);
    return;
  }

  pendingRequests.delete(requestKey);
  const menteeUser = await prisma.user.findUnique({ where: { id: menteeId } });
  await bot.sendMessage(chatId, texts.messages.requestAccepted);
  if (menteeUser) {
    await bot.sendMessage(Number(menteeUser.telegramId), texts.messages.acceptedNotification);
  }
});

bot.onText(/\/decline_(\d+)/, async (msg: Message, match: RegExpExecArray | null) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const menteeId = Number(match?.[1]);

  const mentorUser = await prisma.user.findUnique({ where: { telegramId } });
  if (!mentorUser) {
    return;
  }

  const requestKey = `${telegramId}:${menteeId}`;
  const request = pendingRequests.get(requestKey);
  if (!request) {
    await bot.sendMessage(chatId, texts.messages.noPendingRequest);
    return;
  }

  pendingRequests.delete(requestKey);
  const menteeUser = await prisma.user.findUnique({ where: { id: menteeId } });
  await bot.sendMessage(chatId, texts.messages.requestDeclined);
  if (menteeUser) {
    await bot.sendMessage(Number(menteeUser.telegramId), texts.messages.declinedNotification);
  }
});

bot.on('message', async (msg: Message) => {
  if (!msg.text || msg.text.startsWith('/')) {
    return;
  }

  const telegramId = String(msg.from?.id);
  const state = userStates.get(telegramId);
  if (!state) {
    return;
  }

  const currentStep = ONBOARDING_STEPS[state.role][state.stepIndex];
  state.profile[currentStep] = msg.text;
  state.stepIndex += 1;

  const nextStep = ONBOARDING_STEPS[state.role][state.stepIndex];
  if (!nextStep) {
    const roleText = state.role === 'mentor' ? 'mentor' : 'mentee';
    const profileText = Object.entries(state.profile)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');

    await prisma.user.update({
      where: { telegramId },
      data: {
        role: state.role === 'mentor' ? 'MENTOR' : 'MENTEE',
        ...(state.role === 'mentor'
          ? {
              mentorProfile: {
                create: {
                  name: state.profile.name || 'Mentor',
                  skills: (state.profile.skills || '').split(',').map((item) => item.trim()).filter(Boolean),
                  experienceYears: Number(state.profile.experience || 0),
                  location: state.profile.location || null,
                  contactMethod: state.profile.contact || null,
                },
              },
            }
          : {
              menteeProfile: {
                create: {
                  name: state.profile.name || 'Mentee',
                  goals: state.profile.goals || null,
                  skillsNeeded: (state.profile.skills || '').split(',').map((item) => item.trim()).filter(Boolean),
                  experienceYears: Number(state.profile.experience || 0),
                  location: state.profile.location || null,
                },
              },
            }),
      },
    });

    userStates.delete(telegramId);
    await bot.sendMessage(msg.chat.id, `Thanks! Your ${roleText} profile is ready.\n\n${profileText}`);
    return;
  }

  const skillPrompt = texts.prompts.skills;
  const nextPrompt = texts.prompts[nextStep];
  if (nextStep === 'skills') {
    await bot.sendMessage(msg.chat.id, skillPrompt, {
      reply_markup: buildSkillKeyboard(),
    });
  } else {
    await bot.sendMessage(msg.chat.id, nextPrompt || texts.messages.pleaseContinue);
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
