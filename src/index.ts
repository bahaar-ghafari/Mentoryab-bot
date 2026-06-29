import dotenv from 'dotenv';
import express from 'express';
import TelegramBot, { type Message } from 'node-telegram-bot-api';
import { PrismaClient } from '@prisma/client';
import { findMentorMatches } from './matching.js';
import { texts } from './i18n/en.js';

const ONBOARDING_STEPS = {
  mentor: ['name', 'skills', 'experience', 'country', 'city', 'contact'],
  mentee: ['name', 'goals', 'skills', 'experience', 'country', 'city'],
} as const;

type OnboardingStep = typeof ONBOARDING_STEPS['mentor'][number] | typeof ONBOARDING_STEPS['mentee'][number];
type SubStep = 'year' | 'month' | 'customCountry';

interface UserState {
  role: 'mentor' | 'mentee';
  stepIndex: number;
  profile: Record<string, string>;
  awaitingSubStep?: SubStep;
}

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const port = Number(process.env.PORT || 3000);
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminIds = new Set((process.env.ADMIN_TELEGRAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

function buildYearKeyboard() {
  const currentYear = new Date().getFullYear();
  const years: string[] = [];
  for (let y = 1990; y <= currentYear; y++) years.push(String(y));
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < years.length; i += 5) {
    rows.push(years.slice(i, i + 5).map((y) => ({ text: y, callback_data: `startyear:${y}` })));
  }
  return { inline_keyboard: rows };
}

function buildMonthKeyboard(year: string) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < 12; i += 4) {
    rows.push(
      MONTH_SHORT.slice(i, i + 4).map((m, j) => ({
        text: m,
        callback_data: `startmonth:${year}:${String(i + j + 1).padStart(2, '0')}`,
      }))
    );
  }
  return { inline_keyboard: rows };
}

function buildCountryKeyboard() {
  return {
    keyboard: texts.countryOptions.map((c) => [{ text: c }]),
    one_time_keyboard: true,
    resize_keyboard: true,
  };
}

function buildMainMenuKeyboard(isMentor = false, isAdmin = false) {
  const keyboard: Array<Array<{ text: string }>> = [];
  keyboard.push([{ text: texts.startMenu.joinMentors }, { text: texts.startMenu.needMentor }]);
  if (isMentor) {
    keyboard.push([{ text: texts.startMenu.busy }, { text: texts.startMenu.available }]);
  }
  if (isAdmin) {
    keyboard.push([{ text: texts.startMenu.adminMentors }, { text: texts.startMenu.adminMentees }]);
    keyboard.push([{ text: texts.startMenu.adminRestart }]);
  }
  keyboard.push([{ text: texts.startMenu.help }]);
  return {
    keyboard,
    resize_keyboard: true,
  };
}

function calcExperienceYears(startDateStr: string): number {
  const [year, month] = startDateStr.split('-').map(Number);
  const now = new Date();
  const years = now.getFullYear() - year;
  const monthDiff = now.getMonth() + 1 - month;
  return Math.max(0, monthDiff < 0 ? years - 1 : years);
}

if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is required');
}

const bot = new TelegramBot(token, { polling: true });

const userStates = new Map<string, UserState>();
const pendingRequests = new Map<string, { mentorId: number; menteeId: number }>();

async function sendStepPrompt(chatId: number, step: string, role: 'mentor' | 'mentee', telegramId: string) {
  if (step === 'skills') {
    const prompt = role === 'mentor' ? texts.prompts.skillsMentor : texts.prompts.skillsMentee;
    await bot.sendMessage(chatId, prompt, { reply_markup: buildSkillKeyboard() });
  } else if (step === 'experience') {
    const state = userStates.get(telegramId);
    if (state) state.awaitingSubStep = 'year';
    await bot.sendMessage(chatId, texts.prompts.experience, { reply_markup: buildYearKeyboard() });
  } else if (step === 'country') {
    await bot.sendMessage(chatId, texts.prompts.country, { reply_markup: buildCountryKeyboard() });
  } else if (step === 'city') {
    await bot.sendMessage(chatId, texts.prompts.city, { reply_markup: { remove_keyboard: true } });
  } else {
    const prompts = texts.prompts as Record<string, string>;
    await bot.sendMessage(chatId, prompts[step] ?? texts.messages.pleaseContinue);
  }
}

async function finishOnboarding(chatId: number, telegramId: string, state: UserState) {
  const roleText = state.role === 'mentor' ? 'mentor' : 'mentee';
  const location = state.profile.city && state.profile.country
    ? `${state.profile.city}, ${state.profile.country}`
    : state.profile.country || state.profile.city || null;
  const experienceYears = state.profile.experience ? calcExperienceYears(state.profile.experience) : 0;

  const isMentorNow = state.role === 'mentor';

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
                experienceYears,
                location,
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
                experienceYears,
                location,
              },
            },
          }),
    },
  });

  userStates.delete(telegramId);

  const summary = [
    `Name: ${state.profile.name}`,
    `Skills: ${state.profile.skills}`,
    state.profile.experience ? `Started career: ${state.profile.experience}` : null,
    location ? `Location: ${location}` : null,
    state.profile.contact ? `Contact: ${state.profile.contact}` : null,
    state.profile.goals ? `Goals: ${state.profile.goals}` : null,
  ].filter(Boolean).join('\n');

  await bot.sendMessage(chatId, `Thanks! Your ${roleText} profile is ready.\n\n${summary}`);
  await bot.sendMessage(chatId, texts.chooseRole, {
    reply_markup: buildMainMenuKeyboard(isMentorNow, adminIds.has(telegramId)),
  });
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

bot.onText(/\/myid/, async (msg: Message) => {
  await bot.sendMessage(msg.chat.id, `Your Telegram ID: ${msg.from?.id}`);
});

bot.onText(/\/mentors/, async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;

  const mentors = await prisma.mentorProfile.findMany({ orderBy: { createdAt: 'asc' } });
  if (!mentors.length) {
    await bot.sendMessage(msg.chat.id, 'No mentors registered yet.');
    return;
  }

  const lines = mentors.map((m, i) => {
    const status = m.availability ? 'Available' : 'Busy';
    const exp = m.experienceYears === 1 ? '1 yr' : `${m.experienceYears} yrs`;
    return [
      `${i + 1}. ${m.name} [${status}]`,
      `   Skills: ${m.skills.join(', ')}`,
      `   Exp: ${exp}`,
      m.location ? `   Location: ${m.location}` : null,
      m.contactMethod ? `   Contact: ${m.contactMethod}` : null,
    ].filter(Boolean).join('\n');
  });

  await bot.sendMessage(msg.chat.id, lines.join('\n\n'));
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

  const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true } });
  await bot.sendMessage(chatId, `${texts.welcome}\n\n${texts.chooseRole}`, {
    reply_markup: buildMainMenuKeyboard(Boolean(user?.mentorProfile), adminIds.has(telegramId)),
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

bot.onText(/^Become Mentor$/i, startMentorOnboarding);
bot.onText(/^Find Mentor$/i, startMenteeOnboarding);

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
  const inlineKeyboard = topMatches.map((mentor) => [
    { text: `Request ${mentor.name}`, callback_data: `request:${mentor.id}` },
  ]);
  for (const mentor of topMatches) {
    reply += `\n${mentor.name} — skills: ${mentor.skills.join(', ')} — experience: ${mentor.experienceYears} years — location: ${mentor.location || 'N/A'}\n`;
  }

  await bot.sendMessage(chatId, reply, {
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
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

const handleAdminMentorsList = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;

  const mentors = await prisma.mentorProfile.findMany({ orderBy: { createdAt: 'asc' } });
  if (!mentors.length) {
    await bot.sendMessage(msg.chat.id, 'No mentors registered yet.');
    return;
  }

  const lines = mentors.map((m, i) => {
    const status = m.availability ? 'Available' : 'Busy';
    const exp = m.experienceYears === 1 ? '1 yr' : `${m.experienceYears} yrs`;
    return [
      `${i + 1}. ${m.name} [${status}]`,
      `   Skills: ${m.skills.join(', ')}`,
      `   Exp: ${exp}`,
      m.location ? `   Location: ${m.location}` : null,
      m.contactMethod ? `   Contact: ${m.contactMethod}` : null,
    ].filter(Boolean).join('\n');
  });

  await bot.sendMessage(msg.chat.id, `Mentors (${mentors.length}):\n\n${lines.join('\n\n')}`);
};

const handleAdminMenteesList = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;

  const mentees = await prisma.menteeProfile.findMany({ orderBy: { createdAt: 'asc' } });
  if (!mentees.length) {
    await bot.sendMessage(msg.chat.id, 'No mentees registered yet.');
    return;
  }

  const lines = mentees.map((m, i) => {
    const exp = m.experienceYears != null
      ? (m.experienceYears === 1 ? '1 yr' : `${m.experienceYears} yrs`)
      : null;
    return [
      `${i + 1}. ${m.name}`,
      `   Skills: ${m.skillsNeeded.join(', ')}`,
      exp ? `   Exp: ${exp}` : null,
      m.location ? `   Location: ${m.location}` : null,
      m.goals ? `   Goals: ${m.goals}` : null,
    ].filter(Boolean).join('\n');
  });

  await bot.sendMessage(msg.chat.id, `Mentees (${mentees.length}):\n\n${lines.join('\n\n')}`);
};

const handleAdminRestart = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  await bot.sendMessage(msg.chat.id, 'Restarting...');
  setTimeout(() => process.exit(0), 500);
};

bot.on('callback_query', async (callbackQuery) => {
  if (!callbackQuery.data) return;
  const data = callbackQuery.data as string;
  const chatId = callbackQuery.message?.chat.id;
  const telegramId = String(callbackQuery.from?.id);

  // Year selected from career start date picker
  if (data.startsWith('startyear:')) {
    const year = data.split(':')[1];
    const state = userStates.get(telegramId);
    if (!state || state.awaitingSubStep !== 'year') return;
    state.profile.startYear = year;
    state.awaitingSubStep = 'month';
    if (chatId) {
      await bot.sendMessage(chatId, `${texts.prompts.experienceMonth}`, {
        reply_markup: buildMonthKeyboard(year),
      });
    }
    await bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Month selected from career start date picker
  if (data.startsWith('startmonth:')) {
    const [, year, monthStr] = data.split(':');
    const state = userStates.get(telegramId);
    if (!state || state.awaitingSubStep !== 'month') return;
    const monthName = MONTH_SHORT[Number(monthStr) - 1];
    state.profile.experience = `${year}-${monthStr}`;
    state.awaitingSubStep = undefined;
    state.stepIndex += 1;
    await bot.answerCallbackQuery(callbackQuery.id);
    if (chatId) {
      await bot.sendMessage(chatId, `Career start: ${monthName} ${year}`);
      const nextStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string | undefined;
      if (!nextStep) {
        await finishOnboarding(chatId, telegramId, state);
      } else {
        await sendStepPrompt(chatId, nextStep, state.role, telegramId);
      }
    }
    return;
  }

  if (data.startsWith('request:')) {
    const mentorId = Number(data.split(':')[1]);
    const mentee = await prisma.user.findUnique({ where: { telegramId }, include: { menteeProfile: true } });
    if (!mentee?.menteeProfile) {
      if (chatId) await bot.sendMessage(chatId, texts.messages.completeMenteeProfile);
      return;
    }

    const mentor = await prisma.mentorProfile.findUnique({ where: { id: mentorId } });
    if (!mentor) {
      if (chatId) await bot.sendMessage(chatId, texts.messages.mentorNotFound);
      return;
    }

    const mentorUser = await prisma.user.findUnique({ where: { id: mentor.userId } });
    if (!mentorUser) {
      if (chatId) await bot.sendMessage(chatId, texts.messages.mentorUserNotFound);
      return;
    }

    pendingRequests.set(`${mentorUser.telegramId}:${mentee.id}`, { mentorId: mentor.id, menteeId: mentee.id });
    if (chatId) await bot.sendMessage(chatId, format(texts.messages.requestSent, { mentorName: mentor.name }));

    const acceptDeclineKeyboard = {
      inline_keyboard: [[
        { text: 'Accept', callback_data: `accept:${mentee.id}` },
        { text: 'Decline', callback_data: `decline:${mentee.id}` },
      ]],
    };

    await bot.sendMessage(
      Number(mentorUser.telegramId),
      format(texts.messages.requestNew, { menteeName: mentee.menteeProfile.name, menteeId: mentee.id }),
      { reply_markup: acceptDeclineKeyboard }
    );
    return;
  }

  if (data.startsWith('accept:') || data.startsWith('decline:')) {
    const [action, menteeIdStr] = data.split(':');
    const menteeId = Number(menteeIdStr);
    const mentorTelegramId = String(callbackQuery.from?.id);
    const requestKey = `${mentorTelegramId}:${menteeId}`;
    const request = pendingRequests.get(requestKey);
    if (!request) {
      if (chatId) await bot.sendMessage(chatId, texts.messages.noPendingRequest);
      return;
    }

    pendingRequests.delete(requestKey);
    const menteeUser = await prisma.user.findUnique({ where: { id: menteeId } });
    if (action === 'accept') {
      if (chatId) await bot.sendMessage(chatId, texts.messages.requestAccepted);
      if (menteeUser) await bot.sendMessage(Number(menteeUser.telegramId), texts.messages.acceptedNotification);
    } else {
      if (chatId) await bot.sendMessage(chatId, texts.messages.requestDeclined);
      if (menteeUser) await bot.sendMessage(Number(menteeUser.telegramId), texts.messages.declinedNotification);
    }
    return;
  }
});

bot.on('message', async (msg: Message) => {
  if (!msg.text || msg.text.startsWith('/')) {
    return;
  }

  const text = msg.text;
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const state = userStates.get(telegramId);
  if (!state) {
    // Become Mentor / Find Mentor are handled by onText above; only wire the rest here
    if (text === texts.startMenu.busy) { await handleSetBusy(msg); return; }
    if (text === texts.startMenu.available) { await handleSetAvailable(msg); return; }
    if (text === texts.startMenu.help) { await handleHelp(msg); return; }
    if (text === texts.startMenu.adminMentors) { await handleAdminMentorsList(msg); return; }
    if (text === texts.startMenu.adminMentees) { await handleAdminMenteesList(msg); return; }
    if (text === texts.startMenu.adminRestart) { await handleAdminRestart(msg); return; }
    return;
  }

  // While waiting for inline keyboard (year/month), reject text input
  if (state.awaitingSubStep === 'year' || state.awaitingSubStep === 'month') {
    await bot.sendMessage(chatId, texts.messages.useButtons);
    return;
  }

  // While waiting for custom country text input
  if (state.awaitingSubStep === 'customCountry') {
    if (!text.trim()) {
      await bot.sendMessage(chatId, texts.prompts.countryCustom);
      return;
    }
    state.profile.country = text.trim();
    state.awaitingSubStep = undefined;
    state.stepIndex += 1;
    const nextStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string | undefined;
    if (!nextStep) {
      await finishOnboarding(chatId, telegramId, state);
    } else {
      await sendStepPrompt(chatId, nextStep, state.role, telegramId);
    }
    return;
  }

  const currentStep = ONBOARDING_STEPS[state.role][state.stepIndex] as OnboardingStep;

  // If user selects "Other" for country, ask them to type it
  if (currentStep === 'country' && text === 'Other') {
    state.awaitingSubStep = 'customCountry';
    await bot.sendMessage(chatId, texts.prompts.countryCustom, { reply_markup: { remove_keyboard: true } });
    return;
  }

  state.profile[currentStep] = text;
  state.stepIndex += 1;

  const nextStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string | undefined;
  if (!nextStep) {
    await finishOnboarding(chatId, telegramId, state);
    return;
  }

  await sendStepPrompt(chatId, nextStep, state.role, telegramId);
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
