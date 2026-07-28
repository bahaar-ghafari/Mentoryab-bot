import dotenv from 'dotenv';
import express from 'express';
import TelegramBot, { type Message } from 'node-telegram-bot-api';
import { PrismaClient } from '@prisma/client';
import { findMentorMatches } from './matching.js';
import { texts } from './i18n/en.js';
import {
  ContactType,
  CONTACT_LABELS,
  buildContactTypeKeyboard,
  renderContactMethodsSummary,
} from './contact.js';

const ONBOARDING_STEPS = {
  mentor: ['name', 'title', 'skills', 'experience', 'country', 'city', 'contact'],
  mentee: ['name', 'goals', 'skills', 'experience', 'country', 'city'],
} as const;

type OnboardingStep = typeof ONBOARDING_STEPS['mentor'][number] | typeof ONBOARDING_STEPS['mentee'][number];
type SubStep = 'year' | 'month';

interface UserState {
  role: 'mentor' | 'mentee';
  stepIndex: number;
  profile: Record<string, string>;
  awaitingSubStep?: SubStep;
  currentMessageId?: number;
  selectedSkills: string[];
  contactMethods?: Partial<Record<ContactType, string>>;
  awaitingContactType?: ContactType;
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

  // Predefined options
  for (let i = 0; i < options.length; i += 2) {
    rows.push(
      options.slice(i, i + 2).map((skill) => ({
        text: selected.includes(skill) ? `✅ ${skill}` : skill,
        callback_data: `toggle_skill:${skill}`,
      }))
    );
  }

  // Custom typed skills not in predefined list — always shown as selected ✅
  const custom = selected.filter((s) => !options.some((o) => o.toLowerCase() === s.toLowerCase()));
  for (let i = 0; i < custom.length; i += 2) {
    rows.push(
      custom.slice(i, i + 2).map((skill) => ({
        text: `✅ ${skill}`,
        callback_data: `toggle_skill:${skill}`,
      }))
    );
  }

  const actionRow: Array<{ text: string; callback_data: string }> = [];
  if (canGoBack) actionRow.push({ text: '← Back', callback_data: 'back' });
  actionRow.push({
    text: selected.length > 0 ? `Done ✅ (${selected.length})` : 'Done',
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
  if (canGoBack) rows.push([{ text: '← Back', callback_data: 'back' }]);
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
  const navRow: Array<{ text: string; callback_data: string }> = [];
  if (canGoBack) navRow.push({ text: '← Back', callback_data: 'back' });
  navRow.push({ text: 'Skip', callback_data: 'skip' });
  rows.push(navRow);
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

    case 'city': {
      text = texts.prompts.city;
      const cityNav: Array<{ text: string; callback_data: string }> = [];
      if (canGoBack) cityNav.push({ text: '← Back', callback_data: 'back' });
      cityNav.push({ text: 'Skip', callback_data: 'skip' });
      reply_markup = { inline_keyboard: [cityNav] };
      break;
    }

    case 'contact': {
      const collected = state.contactMethods || {};
      const collectedStr = (Object.keys(collected) as ContactType[])
        .map((t) => `✅ ${CONTACT_LABELS[t]}: ${collected[t]}`)
        .join('\n');
      text = collectedStr
        ? `${collectedStr}\n\nWould you like to add another contact method?`
        : texts.prompts.contact;
      reply_markup = buildContactTypeKeyboard(collected, canGoBack);
      break;
    }

    default: {
      const prompts = texts.prompts as Record<string, string>;
      text = prompts[step] ?? texts.messages.pleaseContinue;
      reply_markup = canGoBack
        ? { inline_keyboard: [[backBtn]] }
        : { inline_keyboard: [] as unknown[] };
    }
  }

  const markup = reply_markup as TelegramBot.InlineKeyboardMarkup;

  if (state.currentMessageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: state.currentMessageId,
        reply_markup: markup,
      });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('message is not modified')) {
        console.error('editMessageText failed, sending new message:', msg);
      }
    }
  }

  // Fallback: send a fresh message and track its ID
  const sent = await bot.sendMessage(chatId, text, { reply_markup: markup });
  state.currentMessageId = (sent as Message).message_id;
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

  const contactMethods = state.contactMethods
    ? (Object.entries(state.contactMethods) as Array<[ContactType, string]>)
        .map(([type, value]) => `${CONTACT_LABELS[type]}: ${value}`)
    : [];

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
                country: state.profile.country || null,
                city: state.profile.city || null,
                location,
                contactMethods,
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
                country: state.profile.country || null,
                city: state.profile.city || null,
                location,
              },
            },
          }),
    },
  });

  userStates.delete(telegramId);

  const contactSummary = renderContactMethodsSummary(state.contactMethods);
  const summary = [
    `Name: ${state.profile.name}`,
    state.profile.title ? `Title: ${state.profile.title}` : null,
    `Skills: ${state.profile.skills}`,
    state.profile.experience ? `Career start: ${state.profile.experience}` : null,
    location ? `Location: ${location}` : null,
    contactSummary ? `Contact: ${contactSummary}` : null,
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
    m.contactMethods.length ? `   Contact: ${m.contactMethods.join(', ')}` : null,
  ].filter(Boolean).join('\n'));
  await bot.sendMessage(msg.chat.id, `Mentors (${mentors.length}):\n\n${lines.join('\n\n')}`);
});

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
  const sent = await bot.sendMessage(chatId, `Let's create your mentor profile.\n\n${texts.prompts.name}`);
  state.currentMessageId = (sent as Message).message_id;
};

const startMenteeOnboarding = async (msg: Message) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const state: UserState = { role: 'mentee', stepIndex: 0, profile: {}, selectedSkills: [] };
  userStates.set(telegramId, state);
  const sent = await bot.sendMessage(chatId, `Let's create your mentee profile.\n\n${texts.prompts.name}`);
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
    m.contactMethods.length ? `   Contact: ${m.contactMethods.join(', ')}` : null,
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
    if (!chatId) return;
    if (!state || state.stepIndex === 0) {
      await bot.sendMessage(chatId, 'Session expired. Please tap Become Mentor or Find Mentor to start again.');
      return;
    }
    state.awaitingSubStep = undefined;
    state.awaitingContactType = undefined;
    state.stepIndex -= 1;
    const prevStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string;
    await showStep(chatId, prevStep, state.role, telegramId);
    return;
  }

  // ── Skip optional step ──
  if (data === 'skip') {
    if (!state || !chatId) return;
    state.stepIndex += 1;
    const nextStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string | undefined;
    if (!nextStep) { await finishOnboarding(chatId, telegramId, state); return; }
    await showStep(chatId, nextStep, state.role, telegramId);
    return;
  }

  // ── Contact type selected ──
  if (data.startsWith('contact_type:')) {
    if (!state || !chatId) return;
    const contactType = data.slice('contact_type:'.length) as ContactType;
    state.awaitingContactType = contactType;
    const prompts: Record<ContactType, string> = {
      telegram: texts.prompts.contactTelegram,
      phone: texts.prompts.contactPhone,
      email: texts.prompts.contactEmail,
    };
    await bot.editMessageText(prompts[contactType], {
      chat_id: chatId,
      message_id: state.currentMessageId,
      reply_markup: { inline_keyboard: [[{ text: '← Back', callback_data: 'contact_back_to_types' }]] },
    }).catch(() => {});
    return;
  }

  // ── Back from contact entry to type selector ──
  if (data === 'contact_back_to_types') {
    if (!state || !chatId) return;
    state.awaitingContactType = undefined;
    const collected = state.contactMethods || {};
    const collectedStr = (Object.keys(collected) as ContactType[])
      .map((t) => `✅ ${CONTACT_LABELS[t]}: ${collected[t]}`)
      .join('\n');
    const prompt = collectedStr
      ? `${collectedStr}\n\nWould you like to add another contact method?`
      : texts.prompts.contact;
    await bot.editMessageText(prompt, {
      chat_id: chatId,
      message_id: state.currentMessageId,
      reply_markup: buildContactTypeKeyboard(collected, state.stepIndex > 0),
    }).catch(() => {});
    return;
  }

  // ── Contact done ──
  if (data === 'contact_done') {
    if (!state || !chatId) return;
    const collected = state.contactMethods || {};
    if (Object.keys(collected).length === 0) {
      await bot.sendMessage(chatId, 'Please add at least one contact method before continuing.');
      return;
    }
    state.stepIndex += 1;
    const nextStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string | undefined;
    if (!nextStep) { await finishOnboarding(chatId, telegramId, state); return; }
    await showStep(chatId, nextStep, state.role, telegramId);
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

  // ── Mentorship request ──
  if (data.startsWith('request:')) {
    const mentorId = Number(data.split(':')[1]);
    const mentee = await prisma.user.findUnique({ where: { telegramId }, include: { menteeProfile: true } });
    if (!mentee?.menteeProfile) { if (chatId) await bot.sendMessage(chatId, texts.messages.completeMenteeProfile); return; }
    const mentor = await prisma.mentorProfile.findUnique({ where: { id: mentorId } });
    if (!mentor) { if (chatId) await bot.sendMessage(chatId, texts.messages.mentorNotFound); return; }
    const mentorUser = await prisma.user.findUnique({ where: { id: mentor.userId } });
    if (!mentorUser) { if (chatId) await bot.sendMessage(chatId, texts.messages.mentorUserNotFound); return; }

    const existingRequest = await prisma.mentorshipRequest.findFirst({
      where: {
        mentorProfileId: mentor.id,
        menteeProfileId: mentee.menteeProfile.id,
        status: 'PENDING',
      },
    });
    if (existingRequest) {
      if (chatId) await bot.sendMessage(chatId, texts.messages.alreadyRequested);
      return;
    }

    await prisma.mentorshipRequest.create({
      data: {
        mentorProfileId: mentor.id,
        menteeProfileId: mentee.menteeProfile.id,
      },
    });

    if (chatId) await bot.sendMessage(chatId, format(texts.messages.requestSent, { mentorName: mentor.name }));
    await bot.sendMessage(
      Number(mentorUser.telegramId),
      format(texts.messages.requestNew, { menteeName: mentee.menteeProfile.name, menteeId: mentee.menteeProfile.id }),
      { reply_markup: { inline_keyboard: [[{ text: 'Accept', callback_data: `accept:${mentee.menteeProfile.id}` }, { text: 'Decline', callback_data: `decline:${mentee.menteeProfile.id}` }]] } }
    );
    return;
  }

  // ── Accept / Decline ──
  if (data.startsWith('accept:') || data.startsWith('decline:')) {
    const [action, menteeProfileIdStr] = data.split(':');
    const menteeProfileId = Number(menteeProfileIdStr);
    const mentorUser = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true } });
    if (!mentorUser?.mentorProfile) { if (chatId) await bot.sendMessage(chatId, texts.messages.needMentorProfile); return; }

    const request = await prisma.mentorshipRequest.findFirst({
      where: {
        mentorProfileId: mentorUser.mentorProfile.id,
        menteeProfileId,
        status: 'PENDING',
      },
    });
    if (!request) { if (chatId) await bot.sendMessage(chatId, texts.messages.noPendingRequest); return; }

    await prisma.mentorshipRequest.update({
      where: { id: request.id },
      data: { status: action === 'accept' ? 'ACCEPTED' : 'DECLINED' },
    });

    const menteeProfile = await prisma.menteeProfile.findUnique({ where: { id: menteeProfileId }, include: { user: true } });
    if (action === 'accept') {
      if (chatId) await bot.sendMessage(chatId, texts.messages.requestAccepted);
      if (menteeProfile?.user) await bot.sendMessage(Number(menteeProfile.user.telegramId), texts.messages.acceptedNotification);
    } else {
      if (chatId) await bot.sendMessage(chatId, texts.messages.requestDeclined);
      if (menteeProfile?.user) await bot.sendMessage(Number(menteeProfile.user.telegramId), texts.messages.declinedNotification);
    }
    return;
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

  // Normal text step
  const currentStep = ONBOARDING_STEPS[state.role][state.stepIndex] as OnboardingStep;

  // Contact step: awaiting a typed value for a chosen contact type
  if (currentStep === 'contact') {
    if (!state.awaitingContactType) {
      // No type chosen yet — nudge to use buttons
      await bot.sendMessage(chatId, texts.messages.useButtons);
      return;
    }
    if (!state.contactMethods) state.contactMethods = {};
    state.contactMethods[state.awaitingContactType] = text;
    state.awaitingContactType = undefined;
    const collected = state.contactMethods;
    const all: ContactType[] = ['telegram', 'phone', 'email'];
    const remaining = all.filter((t) => !collected[t]);
    const collectedStr = (Object.keys(collected) as ContactType[])
      .map((t) => `✅ ${CONTACT_LABELS[t]}: ${collected[t]}`)
      .join('\n');
    const prompt = remaining.length > 0
      ? `${collectedStr}\n\nWould you like to add another contact method?`
      : `${collectedStr}\n\nAll contact methods added!`;
    try {
      await bot.editMessageText(prompt, {
        chat_id: chatId,
        message_id: state.currentMessageId,
        reply_markup: buildContactTypeKeyboard(collected, state.stepIndex > 0),
      });
    } catch {
      const sent = await bot.sendMessage(chatId, prompt, {
        reply_markup: buildContactTypeKeyboard(collected, state.stepIndex > 0),
      });
      state.currentMessageId = (sent as Message).message_id;
    }
    return;
  }

  // Skills step: typing adds to selection; only Done advances
  if (currentStep === 'skills') {
    const typed = text.split(',').map((s) => s.trim()).filter(Boolean);
    for (const s of typed) {
      if (!state.selectedSkills.includes(s)) state.selectedSkills.push(s);
    }
    const skillOpts = await getSkillOptions();
    const markup = buildSkillsInlineKeyboard(skillOpts, state.selectedSkills, state.stepIndex > 0);
    try {
      await bot.editMessageReplyMarkup(markup, { chat_id: chatId, message_id: state.currentMessageId });
    } catch (err) {
      console.error('skill keyboard update failed:', err);
    }
    return;
  }

  state.profile[currentStep] = text;
  state.stepIndex += 1;

  const nextStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string | undefined;
  if (!nextStep) { await finishOnboarding(chatId, telegramId, state); return; }
  await showStep(chatId, nextStep, state.role, telegramId);
});

app.listen(port, () => console.log(`Server listening on port ${port}`));
