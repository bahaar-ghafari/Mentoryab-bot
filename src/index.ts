import dotenv from 'dotenv';
import express from 'express';
import TelegramBot, { type Message } from 'node-telegram-bot-api';
import { PrismaClient } from '@prisma/client';
import { findMentorMatches } from './matching.js';
import { texts } from './i18n/en.js';

const ONBOARDING_STEPS = {
  mentor: ['name', 'title', 'skills', 'experience', 'country', 'city', 'contact'],
  mentee: ['name', 'goals', 'skills', 'experience', 'country', 'city'],
} as const;

type OnboardingStep = typeof ONBOARDING_STEPS['mentor'][number] | typeof ONBOARDING_STEPS['mentee'][number];
type SubStep = 'year' | 'month' | 'customCountry' | 'customSkill' | 'customTitle';

interface UserState {
  role: 'mentor' | 'mentee';
  stepIndex: number;
  profile: Record<string, string>;
  awaitingSubStep?: SubStep;
  currentMessageId?: number;
  selectedSkills: string[];
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

// ── Inline keyboard builders ──────────────────────────────────────────────────

async function getSkillOptions(): Promise<string[]> {
  const mentors = await prisma.mentorProfile.findMany({ select: { skills: true } });
  const mentorSkills = [...new Set(mentors.flatMap((m) => m.skills))];
  const base = texts.skillOptions.filter((s) => s !== 'Other');
  const combined = [...base];
  for (const s of mentorSkills) {
    if (!combined.some((o) => o.toLowerCase() === s.toLowerCase())) {
      combined.push(s);
    }
  }
  return combined;
}

function buildSkillsInlineKeyboard(options: string[], selected: string[], canGoBack: boolean) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  for (let i = 0; i < options.length; i += 2) {
    rows.push(
      options.slice(i, i + 2).map((skill) => ({
        text: selected.includes(skill) ? `✓ ${skill}` : skill,
        callback_data: `toggle_skill:${skill}`,
      }))
    );
  }

  rows.push([{ text: '✏️ Type custom', callback_data: 'custom_skill' }]);

  const actionRow: Array<{ text: string; callback_data: string }> = [];
  if (canGoBack) actionRow.push({ text: '← Back', callback_data: 'back' });
  actionRow.push({
    text: selected.length > 0 ? `Done ✓ (${selected.length})` : 'Done',
    callback_data: 'skill_done',
  });
  rows.push(actionRow);

  return { inline_keyboard: rows };
}

function buildTitleInlineKeyboard(canGoBack: boolean) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  const options = texts.titleOptions;
  for (let i = 0; i < options.length; i += 2) {
    rows.push(
      options.slice(i, i + 2).map((t) => ({ text: t, callback_data: `title:${t}` }))
    );
  }
  const lastRow: Array<{ text: string; callback_data: string }> = [];
  if (canGoBack) lastRow.push({ text: '← Back', callback_data: 'back' });
  lastRow.push({ text: '✏️ Type custom', callback_data: 'title_other' });
  rows.push(lastRow);
  return { inline_keyboard: rows };
}

function buildYearKeyboard(canGoBack: boolean) {
  const currentYear = new Date().getFullYear();
  const years: string[] = [];
  for (let y = 1990; y <= currentYear; y++) years.push(String(y));
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < years.length; i += 5) {
    rows.push(years.slice(i, i + 5).map((y) => ({ text: y, callback_data: `startyear:${y}` })));
  }
  if (canGoBack) rows.push([{ text: '← Back', callback_data: 'back' }]);
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
  rows.push([{ text: '← Back to years', callback_data: 'back_to_years' }]);
  return { inline_keyboard: rows };
}

function buildCountryInlineKeyboard(canGoBack: boolean) {
  const options = texts.countryOptions.filter((c) => c !== 'Other');
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < options.length; i += 2) {
    rows.push(
      options.slice(i, i + 2).map((c) => ({ text: c, callback_data: `country:${c}` }))
    );
  }
  const lastRow: Array<{ text: string; callback_data: string }> = [];
  if (canGoBack) lastRow.push({ text: '← Back', callback_data: 'back' });
  lastRow.push({ text: '✏️ Type custom', callback_data: 'country_other' });
  rows.push(lastRow);
  return { inline_keyboard: rows };
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
  return { keyboard, resize_keyboard: true };
}

function calcExperienceYears(startDateStr: string): number {
  const [year, month] = startDateStr.split('-').map(Number);
  const now = new Date();
  const years = now.getFullYear() - year;
  return Math.max(0, now.getMonth() + 1 < month ? years - 1 : years);
}

// ── Core step renderer ────────────────────────────────────────────────────────

async function showStep(chatId: number, step: string, role: 'mentor' | 'mentee', telegramId: string) {
  const state = userStates.get(telegramId);
  if (!state) return;

  const canGoBack = state.stepIndex > 0;
  const backBtn = { text: '← Back', callback_data: 'back' };

  let text: string;
  let reply_markup: object;

  switch (step) {
    case 'title':
      text = texts.prompts.title;
      reply_markup = buildTitleInlineKeyboard(canGoBack);
      break;

    case 'skills': {
      const skillOptions = await getSkillOptions();
      text = role === 'mentor' ? texts.prompts.skillsMentor : texts.prompts.skillsMentee;
      reply_markup = buildSkillsInlineKeyboard(skillOptions, state.selectedSkills, canGoBack);
      break;
    }

    case 'experience':
      state.awaitingSubStep = 'year';
      text = texts.prompts.experience;
      reply_markup = buildYearKeyboard(canGoBack);
      break;

    case 'country':
      text = texts.prompts.country;
      reply_markup = buildCountryInlineKeyboard(canGoBack);
      break;

    default: {
      const prompts = texts.prompts as Record<string, string>;
      text = prompts[step] ?? texts.messages.pleaseContinue;
      reply_markup = canGoBack
        ? { inline_keyboard: [[backBtn]] }
        : { inline_keyboard: [] as unknown[] };
    }
  }

  if (state.currentMessageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: state.currentMessageId,
        reply_markup: reply_markup as TelegramBot.InlineKeyboardMarkup,
      });
    } catch {
      // message unchanged — ignore
    }
  } else {
    const sent = await bot.sendMessage(chatId, text, { reply_markup: reply_markup as TelegramBot.ReplyKeyboardMarkup });
    state.currentMessageId = (sent as Message).message_id;
  }
}

// ── Onboarding finish ─────────────────────────────────────────────────────────

async function finishOnboarding(chatId: number, telegramId: string, state: UserState) {
  const roleText = state.role === 'mentor' ? 'mentor' : 'mentee';
  const location =
    state.profile.city && state.profile.country
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
                title: state.profile.title || null,
                skills: (state.profile.skills || '').split(',').map((s) => s.trim()).filter(Boolean),
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
                skillsNeeded: (state.profile.skills || '').split(',').map((s) => s.trim()).filter(Boolean),
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
    state.profile.title ? `Title: ${state.profile.title}` : null,
    `Skills: ${state.profile.skills}`,
    state.profile.experience ? `Career start: ${state.profile.experience}` : null,
    location ? `Location: ${location}` : null,
    state.profile.contact ? `Contact: ${state.profile.contact}` : null,
    state.profile.goals ? `Goals: ${state.profile.goals}` : null,
  ].filter(Boolean).join('\n');

  // Edit the tracked message to show the summary
  if (state.currentMessageId) {
    try {
      await bot.editMessageText(`Your ${roleText} profile is ready!\n\n${summary}`, {
        chat_id: chatId,
        message_id: state.currentMessageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch { /* ignore */ }
  }

  await bot.sendMessage(chatId, texts.chooseRole, {
    reply_markup: buildMainMenuKeyboard(isMentorNow, adminIds.has(telegramId)),
  });
}

// ── Express & bot setup ───────────────────────────────────────────────────────

if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

const bot = new TelegramBot(token, { polling: true });
const userStates = new Map<string, UserState>();
const pendingRequests = new Map<string, { mentorId: number; menteeId: number }>();

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Admin slash commands ──────────────────────────────────────────────────────

bot.onText(/\/myid/, async (msg: Message) => {
  await bot.sendMessage(msg.chat.id, `Your Telegram ID: ${msg.from?.id}`);
});

bot.onText(/\/mentors/, async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;

  const mentors = await prisma.mentorProfile.findMany({ orderBy: { createdAt: 'asc' } });
  if (!mentors.length) { await bot.sendMessage(msg.chat.id, 'No mentors registered yet.'); return; }

  const lines = mentors.map((m, i) => [
    `${i + 1}. ${m.name} [${m.availability ? 'Available' : 'Busy'}]`,
    m.title ? `   Title: ${m.title}` : null,
    `   Skills: ${m.skills.join(', ')}`,
    `   Exp: ${m.experienceYears} yr${m.experienceYears !== 1 ? 's' : ''}`,
    m.location ? `   Location: ${m.location}` : null,
    m.contactMethod ? `   Contact: ${m.contactMethod}` : null,
  ].filter(Boolean).join('\n'));

  await bot.sendMessage(msg.chat.id, `Mentors (${mentors.length}):\n\n${lines.join('\n\n')}`);
});

// ── /start ────────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg: Message) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);

  await prisma.user.upsert({
    where: { telegramId },
    update: { firstName: msg.from?.first_name || null, lastName: msg.from?.last_name || null, username: msg.from?.username || null },
    create: { telegramId, firstName: msg.from?.first_name || null, lastName: msg.from?.last_name || null, username: msg.from?.username || null },
  });

  const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true } });
  await bot.sendMessage(chatId, `${texts.welcome}\n\n${texts.chooseRole}`, {
    reply_markup: buildMainMenuKeyboard(Boolean(user?.mentorProfile), adminIds.has(telegramId)),
  });
});

// ── Onboarding starters ───────────────────────────────────────────────────────

const startMentorOnboarding = async (msg: Message) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const state: UserState = { role: 'mentor', stepIndex: 0, profile: {}, selectedSkills: [] };
  userStates.set(telegramId, state);
  await bot.sendMessage(chatId, "Let's create your mentor profile.", { reply_markup: { remove_keyboard: true } });
  const sent = await bot.sendMessage(chatId, texts.prompts.name);
  state.currentMessageId = (sent as Message).message_id;
};

const startMenteeOnboarding = async (msg: Message) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const state: UserState = { role: 'mentee', stepIndex: 0, profile: {}, selectedSkills: [] };
  userStates.set(telegramId, state);
  await bot.sendMessage(chatId, "Let's create your mentee profile.", { reply_markup: { remove_keyboard: true } });
  const sent = await bot.sendMessage(chatId, texts.prompts.name);
  state.currentMessageId = (sent as Message).message_id;
};

bot.onText(/^Become Mentor$/i, startMentorOnboarding);
bot.onText(/^Find Mentor$/i, startMenteeOnboarding);

// ── Menu action handlers ──────────────────────────────────────────────────────

const handleMatchRequest = async (msg: Message) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { menteeProfile: true } });

  if (!user?.menteeProfile) { await bot.sendMessage(chatId, texts.messages.completeMenteeProfile); return; }

  const mentors = await prisma.mentorProfile.findMany({ where: { availability: true } });
  const matches = findMentorMatches(
    { name: user.menteeProfile.name, skillsNeeded: user.menteeProfile.skillsNeeded, experienceYears: user.menteeProfile.experienceYears, location: user.menteeProfile.location },
    mentors.map((m) => ({ id: m.id, name: m.name, skills: m.skills, experienceYears: m.experienceYears, location: m.location, availability: m.availability }))
  );

  if (!matches.length) { await bot.sendMessage(chatId, texts.messages.noMentorsAvailable); return; }

  const topMatches = matches.slice(0, 3);
  let reply = texts.messages.topMentorMatches + '\n';
  const inlineKeyboard = topMatches.map((m) => [{ text: `Request ${m.name}`, callback_data: `request:${m.id}` }]);
  for (const m of topMatches) {
    reply += `\n${m.name} — skills: ${m.skills.join(', ')} — exp: ${m.experienceYears}y — location: ${m.location || 'N/A'}\n`;
  }
  await bot.sendMessage(chatId, reply, { reply_markup: { inline_keyboard: inlineKeyboard } });
};

const handleSetBusy = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true } });
  if (!user?.mentorProfile) { await bot.sendMessage(msg.chat.id, texts.messages.needMentorProfile); return; }
  await prisma.mentorProfile.update({ where: { id: user.mentorProfile.id }, data: { availability: false } });
  await bot.sendMessage(msg.chat.id, texts.messages.busySet);
};

const handleSetAvailable = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true } });
  if (!user?.mentorProfile) { await bot.sendMessage(msg.chat.id, texts.messages.needMentorProfile); return; }
  await prisma.mentorProfile.update({ where: { id: user.mentorProfile.id }, data: { availability: true } });
  await bot.sendMessage(msg.chat.id, texts.messages.availableSet);
};

const handleHelp = async (msg: Message) => {
  await bot.sendMessage(msg.chat.id, texts.messages.helpText);
};

const handleAdminMentorsList = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  const mentors = await prisma.mentorProfile.findMany({ orderBy: { createdAt: 'asc' } });
  if (!mentors.length) { await bot.sendMessage(msg.chat.id, 'No mentors registered yet.'); return; }
  const lines = mentors.map((m, i) => [
    `${i + 1}. ${m.name} [${m.availability ? 'Available' : 'Busy'}]`,
    m.title ? `   Title: ${m.title}` : null,
    `   Skills: ${m.skills.join(', ')}`,
    `   Exp: ${m.experienceYears} yr${m.experienceYears !== 1 ? 's' : ''}`,
    m.location ? `   Location: ${m.location}` : null,
    m.contactMethod ? `   Contact: ${m.contactMethod}` : null,
  ].filter(Boolean).join('\n'));
  await bot.sendMessage(msg.chat.id, `Mentors (${mentors.length}):\n\n${lines.join('\n\n')}`);
};

const handleAdminMenteesList = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  const mentees = await prisma.menteeProfile.findMany({ orderBy: { createdAt: 'asc' } });
  if (!mentees.length) { await bot.sendMessage(msg.chat.id, 'No mentees registered yet.'); return; }
  const lines = mentees.map((m, i) => [
    `${i + 1}. ${m.name}`,
    `   Skills: ${m.skillsNeeded.join(', ')}`,
    m.experienceYears != null ? `   Exp: ${m.experienceYears} yr${m.experienceYears !== 1 ? 's' : ''}` : null,
    m.location ? `   Location: ${m.location}` : null,
    m.goals ? `   Goals: ${m.goals}` : null,
  ].filter(Boolean).join('\n'));
  await bot.sendMessage(msg.chat.id, `Mentees (${mentees.length}):\n\n${lines.join('\n\n')}`);
};

const handleAdminRestart = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  await bot.sendMessage(msg.chat.id, 'Restarting...');
  setTimeout(() => process.exit(0), 500);
};

// ── Callback query handler ────────────────────────────────────────────────────

bot.on('callback_query', async (callbackQuery) => {
  if (!callbackQuery.data) return;
  const data = callbackQuery.data as string;
  const chatId = callbackQuery.message?.chat.id;
  const telegramId = String(callbackQuery.from?.id);
  const state = userStates.get(telegramId);

  await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});

  // ── Skill toggle ──
  if (data.startsWith('toggle_skill:')) {
    if (!state || !chatId) return;
    const skill = data.slice('toggle_skill:'.length);
    const idx = state.selectedSkills.indexOf(skill);
    if (idx === -1) state.selectedSkills.push(skill);
    else state.selectedSkills.splice(idx, 1);
    const skillOptions = await getSkillOptions();
    await bot.editMessageReplyMarkup(
      buildSkillsInlineKeyboard(skillOptions, state.selectedSkills, state.stepIndex > 0),
      { chat_id: chatId, message_id: state.currentMessageId }
    );
    return;
  }

  // ── Type custom skill ──
  if (data === 'custom_skill') {
    if (!state || !chatId) return;
    state.awaitingSubStep = 'customSkill';
    await bot.editMessageText('Type your skill(s), comma separated:', {
      chat_id: chatId,
      message_id: state.currentMessageId,
      reply_markup: { inline_keyboard: [[{ text: '← Back to skills', callback_data: 'back_to_skills' }]] },
    });
    return;
  }

  // ── Back to skills from custom input ──
  if (data === 'back_to_skills') {
    if (!state || !chatId) return;
    state.awaitingSubStep = undefined;
    const prompt = state.role === 'mentor' ? texts.prompts.skillsMentor : texts.prompts.skillsMentee;
    const skillOptions = await getSkillOptions();
    await bot.editMessageText(prompt, {
      chat_id: chatId,
      message_id: state.currentMessageId,
      reply_markup: buildSkillsInlineKeyboard(skillOptions, state.selectedSkills, state.stepIndex > 0),
    });
    return;
  }

  // ── Skill done ──
  if (data === 'skill_done') {
    if (!state || !chatId) return;
    state.profile.skills = state.selectedSkills.join(', ');
    state.stepIndex += 1;
    const nextStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string | undefined;
    if (!nextStep) { await finishOnboarding(chatId, telegramId, state); return; }
    await showStep(chatId, nextStep, state.role, telegramId);
    return;
  }

  // ── General back (previous step) ──
  if (data === 'back') {
    if (!state || !chatId || state.stepIndex === 0) return;
    state.awaitingSubStep = undefined;
    // If backing out of a completed skills step, restore selection from profile
    state.stepIndex -= 1;
    const prevStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string;
    await showStep(chatId, prevStep, state.role, telegramId);
    return;
  }

  // ── Year selected ──
  if (data.startsWith('startyear:')) {
    if (!state || !chatId) return;
    const year = data.split(':')[1];
    state.profile.startYear = year;
    state.awaitingSubStep = 'month';
    await bot.editMessageText(texts.prompts.experienceMonth, {
      chat_id: chatId,
      message_id: state.currentMessageId,
      reply_markup: buildMonthKeyboard(year),
    });
    return;
  }

  // ── Back to years from month ──
  if (data === 'back_to_years') {
    if (!state || !chatId) return;
    state.awaitingSubStep = 'year';
    delete state.profile.startYear;
    await bot.editMessageText(texts.prompts.experience, {
      chat_id: chatId,
      message_id: state.currentMessageId,
      reply_markup: buildYearKeyboard(state.stepIndex > 0),
    });
    return;
  }

  // ── Month selected ──
  if (data.startsWith('startmonth:')) {
    if (!state || !chatId) return;
    const [, year, monthStr] = data.split(':');
    const monthName = MONTH_SHORT[Number(monthStr) - 1];
    state.profile.experience = `${year}-${monthStr}`;
    state.awaitingSubStep = undefined;
    state.stepIndex += 1;
    const nextStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string | undefined;
    if (!nextStep) { await finishOnboarding(chatId, telegramId, state); return; }
    // Brief confirmation in the message before transitioning
    try {
      await bot.editMessageText(`Career start: ${monthName} ${year}`, {
        chat_id: chatId,
        message_id: state.currentMessageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch { /* ignore */ }
    await showStep(chatId, nextStep, state.role, telegramId);
    return;
  }

  // ── Title selected ──
  if (data.startsWith('title:') && !data.startsWith('title_')) {
    if (!state || !chatId) return;
    state.profile.title = data.slice('title:'.length);
    state.stepIndex += 1;
    const nextStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string | undefined;
    if (!nextStep) { await finishOnboarding(chatId, telegramId, state); return; }
    await showStep(chatId, nextStep, state.role, telegramId);
    return;
  }

  // ── Type custom title ──
  if (data === 'title_other') {
    if (!state || !chatId) return;
    state.awaitingSubStep = 'customTitle';
    await bot.editMessageText(texts.prompts.titleCustom, {
      chat_id: chatId,
      message_id: state.currentMessageId,
      reply_markup: { inline_keyboard: [[{ text: '← Back to list', callback_data: 'back_to_titles' }]] },
    });
    return;
  }

  // ── Back to titles from custom input ──
  if (data === 'back_to_titles') {
    if (!state || !chatId) return;
    state.awaitingSubStep = undefined;
    await bot.editMessageText(texts.prompts.title, {
      chat_id: chatId,
      message_id: state.currentMessageId,
      reply_markup: buildTitleInlineKeyboard(state.stepIndex > 0),
    });
    return;
  }

  // ── Country selected ──
  if (data.startsWith('country:')) {
    if (!state || !chatId) return;
    state.profile.country = data.slice('country:'.length);
    state.stepIndex += 1;
    const nextStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string | undefined;
    if (!nextStep) { await finishOnboarding(chatId, telegramId, state); return; }
    await showStep(chatId, nextStep, state.role, telegramId);
    return;
  }

  // ── Type custom country ──
  if (data === 'country_other') {
    if (!state || !chatId) return;
    state.awaitingSubStep = 'customCountry';
    await bot.editMessageText(texts.prompts.countryCustom, {
      chat_id: chatId,
      message_id: state.currentMessageId,
      reply_markup: { inline_keyboard: [[{ text: '← Back to list', callback_data: 'back_to_countries' }]] },
    });
    return;
  }

  // ── Back to countries from custom input ──
  if (data === 'back_to_countries') {
    if (!state || !chatId) return;
    state.awaitingSubStep = undefined;
    await bot.editMessageText(texts.prompts.country, {
      chat_id: chatId,
      message_id: state.currentMessageId,
      reply_markup: buildCountryInlineKeyboard(state.stepIndex > 0),
    });
    return;
  }

  // ── Mentorship request ──
  if (data.startsWith('request:')) {
    const mentorId = Number(data.split(':')[1]);
    const mentee = await prisma.user.findUnique({ where: { telegramId }, include: { menteeProfile: true } });
    if (!mentee?.menteeProfile) { if (chatId) await bot.sendMessage(chatId, texts.messages.completeMenteeProfile); return; }
    const mentor = await prisma.mentorProfile.findUnique({ where: { id: mentorId } });
    if (!mentor) { if (chatId) await bot.sendMessage(chatId, texts.messages.mentorNotFound); return; }
    const mentorUser = await prisma.user.findUnique({ where: { id: mentor.userId } });
    if (!mentorUser) { if (chatId) await bot.sendMessage(chatId, texts.messages.mentorUserNotFound); return; }

    pendingRequests.set(`${mentorUser.telegramId}:${mentee.id}`, { mentorId: mentor.id, menteeId: mentee.id });
    if (chatId) await bot.sendMessage(chatId, format(texts.messages.requestSent, { mentorName: mentor.name }));

    await bot.sendMessage(
      Number(mentorUser.telegramId),
      format(texts.messages.requestNew, { menteeName: mentee.menteeProfile.name, menteeId: mentee.id }),
      { reply_markup: { inline_keyboard: [[{ text: 'Accept', callback_data: `accept:${mentee.id}` }, { text: 'Decline', callback_data: `decline:${mentee.id}` }]] } }
    );
    return;
  }

  // ── Accept / Decline ──
  if (data.startsWith('accept:') || data.startsWith('decline:')) {
    const [action, menteeIdStr] = data.split(':');
    const menteeId = Number(menteeIdStr);
    const requestKey = `${telegramId}:${menteeId}`;
    const request = pendingRequests.get(requestKey);
    if (!request) { if (chatId) await bot.sendMessage(chatId, texts.messages.noPendingRequest); return; }

    pendingRequests.delete(requestKey);
    const menteeUser = await prisma.user.findUnique({ where: { id: menteeId } });
    if (action === 'accept') {
      if (chatId) await bot.sendMessage(chatId, texts.messages.requestAccepted);
      if (menteeUser) await bot.sendMessage(Number(menteeUser.telegramId), texts.messages.acceptedNotification);
    } else {
      if (chatId) await bot.sendMessage(chatId, texts.messages.requestDeclined);
      if (menteeUser) await bot.sendMessage(Number(menteeUser.telegramId), texts.messages.declinedNotification);
    }
  }
});

// ── Text message handler ──────────────────────────────────────────────────────

bot.on('message', async (msg: Message) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  const text = msg.text;
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const state = userStates.get(telegramId);

  if (!state) {
    if (text === texts.startMenu.busy) { await handleSetBusy(msg); return; }
    if (text === texts.startMenu.available) { await handleSetAvailable(msg); return; }
    if (text === texts.startMenu.help) { await handleHelp(msg); return; }
    if (text === texts.startMenu.adminMentors) { await handleAdminMentorsList(msg); return; }
    if (text === texts.startMenu.adminMentees) { await handleAdminMenteesList(msg); return; }
    if (text === texts.startMenu.adminRestart) { await handleAdminRestart(msg); return; }
    return;
  }

  // Inline keyboard steps — reject freetext
  if (state.awaitingSubStep === 'year' || state.awaitingSubStep === 'month') {
    await bot.sendMessage(chatId, texts.messages.useButtons);
    return;
  }

  // Custom skill text input
  if (state.awaitingSubStep === 'customSkill') {
    const typed = text.split(',').map((s) => s.trim()).filter(Boolean);
    for (const s of typed) {
      if (!state.selectedSkills.includes(s)) state.selectedSkills.push(s);
    }
    state.awaitingSubStep = undefined;
    const prompt = state.role === 'mentor' ? texts.prompts.skillsMentor : texts.prompts.skillsMentee;
    const skillOpts = await getSkillOptions();
    await bot.editMessageText(prompt, {
      chat_id: chatId,
      message_id: state.currentMessageId,
      reply_markup: buildSkillsInlineKeyboard(skillOpts, state.selectedSkills, state.stepIndex > 0),
    });
    return;
  }

  // Custom title text input
  if (state.awaitingSubStep === 'customTitle') {
    if (!text.trim()) { await bot.sendMessage(chatId, texts.prompts.titleCustom); return; }
    state.profile.title = text.trim();
    state.awaitingSubStep = undefined;
    state.stepIndex += 1;
    const nextStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string | undefined;
    if (!nextStep) { await finishOnboarding(chatId, telegramId, state); return; }
    await showStep(chatId, nextStep, state.role, telegramId);
    return;
  }

  // Custom country text input
  if (state.awaitingSubStep === 'customCountry') {
    if (!text.trim()) { await bot.sendMessage(chatId, texts.prompts.countryCustom); return; }
    state.profile.country = text.trim();
    state.awaitingSubStep = undefined;
    state.stepIndex += 1;
    const nextStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string | undefined;
    if (!nextStep) { await finishOnboarding(chatId, telegramId, state); return; }
    await showStep(chatId, nextStep, state.role, telegramId);
    return;
  }

  // Normal text step
  const currentStep = ONBOARDING_STEPS[state.role][state.stepIndex] as OnboardingStep;
  state.profile[currentStep] = text;
  state.stepIndex += 1;

  const nextStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string | undefined;
  if (!nextStep) { await finishOnboarding(chatId, telegramId, state); return; }
  await showStep(chatId, nextStep, state.role, telegramId);
});

app.listen(port, () => console.log(`Server listening on port ${port}`));
