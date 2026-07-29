import dotenv from 'dotenv';
import express from 'express';
import TelegramBot, { type Message } from 'node-telegram-bot-api';
import { PrismaClient } from '@prisma/client';
import { findMentorMatches } from './matching.js';
import { getTexts, LOCALE_TEXTS, LANGUAGE_CHOICES, isLocale, type Locale, type Texts } from './i18n/index.js';
import { translateOption, getContactLabels } from './i18n/labels.js';
import { SKILL_OPTIONS } from './i18n/options.js';
import {
  ContactType,
  CONTACT_LABELS,
  buildContactTypeKeyboard,
  renderContactMethodsSummary,
  isValidEmail,
} from './contact.js';

const ONBOARDING_STEPS = {
  mentor: ['language', 'name', 'title', 'skills', 'experience', 'country', 'city', 'contact'],
  mentee: ['language', 'name', 'goals', 'skills', 'experience', 'country', 'city'],
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
  language: Locale;
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

// A reply-keyboard button's label depends on the tapping user's language, which we
// don't know until we recognize the button — so match against every locale's label
// rather than requiring a DB lookup just to interpret which button was pressed.
function matchesMenuButton(text: string, key: keyof Texts['startMenu']): boolean {
  return Object.values(LOCALE_TEXTS).some((loc) => loc.startMenu[key] === text);
}

function menuButtonRegex(key: keyof Texts['startMenu']): RegExp {
  const variants = Object.values(LOCALE_TEXTS).map((loc) => loc.startMenu[key]);
  const escaped = variants.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^(${escaped.join('|')})$`, 'i');
}

function renderCollectedContacts(collected: Partial<Record<ContactType, string>>, labels: Record<ContactType, string>): string {
  return (Object.keys(collected) as ContactType[])
    .map((ct) => `✅ ${labels[ct]}: ${collected[ct]}`)
    .join('\n');
}

function languageDisplayName(code: string): string {
  return LANGUAGE_CHOICES.find((l) => l.code === code)?.label ?? code;
}

// ── Inline keyboard builders ──────────────────────────────────────────────────

async function getSkillOptions(): Promise<string[]> {
  const mentors = await prisma.mentorProfile.findMany({ select: { skills: true } });
  const mentorSkills = [...new Set(mentors.flatMap((m) => m.skills))];
  const base = SKILL_OPTIONS.filter((s) => s !== 'Other');
  const combined = [...base];
  for (const s of mentorSkills) {
    if (!combined.some((o) => o.toLowerCase() === s.toLowerCase())) {
      combined.push(s);
    }
  }
  return combined;
}

function buildSkillsInlineKeyboard(options: string[], selected: string[], canGoBack: boolean, t: Texts) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  // Predefined options — canonical value stays in callback_data, label is translated
  for (let i = 0; i < options.length; i += 2) {
    rows.push(
      options.slice(i, i + 2).map((skill) => {
        const label = translateOption(t.locale, skill, 'skill');
        return {
          text: selected.includes(skill) ? `✅ ${label}` : label,
          callback_data: `toggle_skill:${skill}`,
        };
      })
    );
  }

  // Custom typed skills not in predefined list — always shown as selected ✅, untranslated
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
  if (canGoBack) actionRow.push({ text: t.ui.back, callback_data: 'back' });
  actionRow.push({
    text: selected.length > 0 ? `${t.ui.done} ✅ (${selected.length})` : t.ui.done,
    callback_data: 'skill_done',
  });
  rows.push(actionRow);

  return { inline_keyboard: rows };
}

function buildTitleInlineKeyboard(canGoBack: boolean, t: Texts) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  const options = t.titleOptions;
  for (let i = 0; i < options.length; i += 2) {
    rows.push(
      options.slice(i, i + 2).map((opt) => ({ text: translateOption(t.locale, opt, 'title'), callback_data: `title:${opt}` }))
    );
  }
  if (canGoBack) rows.push([{ text: t.ui.back, callback_data: 'back' }]);
  return { inline_keyboard: rows };
}

function buildYearKeyboard(canGoBack: boolean, t: Texts) {
  const currentYear = new Date().getFullYear();
  const years: string[] = [];
  for (let y = 1990; y <= currentYear; y++) years.push(String(y));
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < years.length; i += 5) {
    rows.push(years.slice(i, i + 5).map((y) => ({ text: y, callback_data: `startyear:${y}` })));
  }
  if (canGoBack) rows.push([{ text: t.ui.back, callback_data: 'back' }]);
  return { inline_keyboard: rows };
}

function buildMonthKeyboard(year: string, t: Texts) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < 12; i += 4) {
    rows.push(
      MONTH_SHORT.slice(i, i + 4).map((m, j) => ({
        text: m,
        callback_data: `startmonth:${year}:${String(i + j + 1).padStart(2, '0')}`,
      }))
    );
  }
  rows.push([{ text: t.ui.backToYears, callback_data: 'back_to_years' }]);
  return { inline_keyboard: rows };
}

function buildCountryInlineKeyboard(canGoBack: boolean, t: Texts) {
  const options = t.countryOptions.filter((c) => c !== 'Other');
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < options.length; i += 2) {
    rows.push(
      options.slice(i, i + 2).map((c) => ({ text: translateOption(t.locale, c, 'country'), callback_data: `country:${c}` }))
    );
  }
  const navRow: Array<{ text: string; callback_data: string }> = [];
  if (canGoBack) navRow.push({ text: t.ui.back, callback_data: 'back' });
  navRow.push({ text: t.ui.skip, callback_data: 'skip' });
  rows.push(navRow);
  return { inline_keyboard: rows };
}

function buildLanguageInlineKeyboard() {
  return { inline_keyboard: [LANGUAGE_CHOICES.map((l) => ({ text: l.label, callback_data: `language:${l.code}` }))] };
}

function buildMainMenuKeyboard(isMentor: boolean, isAdmin: boolean, t: Texts) {
  const keyboard: Array<Array<{ text: string }>> = [];
  keyboard.push([{ text: t.startMenu.joinMentors }, { text: t.startMenu.needMentor }]);
  if (isMentor) {
    keyboard.push([{ text: t.startMenu.busy }, { text: t.startMenu.available }]);
  }
  if (isAdmin) {
    keyboard.push([{ text: t.startMenu.adminMentors }, { text: t.startMenu.adminMentees }]);
    keyboard.push([{ text: t.startMenu.adminRestart }]);
  }
  keyboard.push([{ text: t.startMenu.help }]);
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

  const t = getTexts(state.language);
  const canGoBack = state.stepIndex > 0;
  const backBtn = { text: t.ui.back, callback_data: 'back' };

  let text: string;
  let reply_markup: object;

  switch (step) {
    case 'language':
      // Shown before we know the user's preference, so greet in both languages.
      text = `🌐 ${LOCALE_TEXTS.en.prompts.language}\n${LOCALE_TEXTS.fa.prompts.language}`;
      reply_markup = buildLanguageInlineKeyboard();
      break;

    case 'name':
      text = role === 'mentor' ? t.mentorStart : t.menteeStart;
      reply_markup = canGoBack ? { inline_keyboard: [[backBtn]] } : { inline_keyboard: [] as unknown[] };
      break;

    case 'title':
      text = t.prompts.title;
      reply_markup = buildTitleInlineKeyboard(canGoBack, t);
      break;

    case 'skills': {
      const skillOptions = await getSkillOptions();
      text = role === 'mentor' ? t.prompts.skillsMentor : t.prompts.skillsMentee;
      reply_markup = buildSkillsInlineKeyboard(skillOptions, state.selectedSkills, canGoBack, t);
      break;
    }

    case 'experience':
      state.awaitingSubStep = 'year';
      text = t.prompts.experience;
      reply_markup = buildYearKeyboard(canGoBack, t);
      break;

    case 'country':
      text = t.prompts.country;
      reply_markup = buildCountryInlineKeyboard(canGoBack, t);
      break;

    case 'city': {
      text = t.prompts.city;
      const cityNav: Array<{ text: string; callback_data: string }> = [];
      if (canGoBack) cityNav.push({ text: t.ui.back, callback_data: 'back' });
      cityNav.push({ text: t.ui.skip, callback_data: 'skip' });
      reply_markup = { inline_keyboard: [cityNav] };
      break;
    }

    case 'contact': {
      const collected = state.contactMethods || {};
      const labels = getContactLabels(state.language);
      const collectedStr = renderCollectedContacts(collected, labels);
      text = collectedStr
        ? `${collectedStr}\n\n${t.messages.addAnotherContact}`
        : t.prompts.contact;
      reply_markup = buildContactTypeKeyboard(collected, canGoBack, labels, { back: t.ui.back, done: t.ui.done });
      break;
    }

    default: {
      const prompts = t.prompts as Record<string, string>;
      text = prompts[step] ?? t.messages.pleaseContinue;
      reply_markup = canGoBack
        ? { inline_keyboard: [[backBtn]] }
        : { inline_keyboard: [] as unknown[] };
    }
  }

  const totalSteps = ONBOARDING_STEPS[role].length;
  text = `${format(t.ui.stepIndicator, { current: state.stepIndex + 1, total: totalSteps })}\n${text}`;

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
  const t = getTexts(state.language);
  const roleText = state.role === 'mentor' ? t.summary.roleMentor : t.summary.roleMentee;
  const location =
    state.profile.city && state.profile.country
      ? `${state.profile.city}, ${state.profile.country}`
      : state.profile.country || state.profile.city || null;
  const experienceYears = state.profile.experience ? calcExperienceYears(state.profile.experience) : 0;
  const isMentorNow = state.role === 'mentor';

  // Canonical English labels for storage — keeps admin dumps and cross-language
  // matching consistent regardless of the mentor's own UI language.
  const contactMethods = state.contactMethods
    ? (Object.entries(state.contactMethods) as Array<[ContactType, string]>)
        .map(([type, value]) => `${CONTACT_LABELS[type]}: ${value}`)
    : [];

  const role = state.role === 'mentor' ? 'MENTOR' : 'MENTEE';
  const profileRelation = state.role === 'mentor'
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
            language: state.language,
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
            language: state.language,
          },
        },
      };

  // Use upsert, not update: a user who taps "Become Mentor"/"Find Mentor" without
  // ever sending /start first (e.g. from a stale keyboard after a bot restart) has
  // no User row yet, and update() would throw P2025 and crash the whole process.
  await prisma.user.upsert({
    where: { telegramId },
    update: { role, language: state.language, ...profileRelation },
    create: { telegramId, role, language: state.language, ...profileRelation },
  });

  userStates.delete(telegramId);

  // Translated display versions for the summary shown to the user — the DB above
  // always keeps the canonical English values regardless of this.
  const displaySkills = (state.profile.skills || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => translateOption(state.language, s, 'skill'))
    .join(', ');
  const displayTitle = state.profile.title ? translateOption(state.language, state.profile.title, 'title') : null;
  const displayCountry = state.profile.country ? translateOption(state.language, state.profile.country, 'country') : null;
  const displayLocation = state.profile.city && displayCountry
    ? `${state.profile.city}, ${displayCountry}`
    : displayCountry || state.profile.city || null;

  const contactLabels = getContactLabels(state.language);
  const contactSummary = renderContactMethodsSummary(state.contactMethods, contactLabels);
  const summary = [
    `${t.summary.name}: ${state.profile.name}`,
    displayTitle ? `${t.summary.title}: ${displayTitle}` : null,
    `${t.summary.skills}: ${displaySkills}`,
    state.profile.experience ? `${t.summary.careerStart}: ${state.profile.experience}` : null,
    displayLocation ? `${t.summary.location}: ${displayLocation}` : null,
    `${t.summary.language}: ${languageDisplayName(state.language)}`,
    contactSummary ? `${t.summary.contact}: ${contactSummary}` : null,
    state.profile.goals ? `${t.summary.goals}: ${state.profile.goals}` : null,
  ].filter(Boolean).join('\n');

  // Edit the tracked message to show the summary
  if (state.currentMessageId) {
    try {
      await bot.editMessageText(`${format(t.profileReady, { role: roleText })}\n\n${summary}`, {
        chat_id: chatId,
        message_id: state.currentMessageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch { /* ignore */ }
  }

  await bot.sendMessage(chatId, t.chooseRole, {
    reply_markup: buildMainMenuKeyboard(isMentorNow, adminIds.has(telegramId), t),
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
  await handleAdminMentorsList(msg);
});

bot.onText(/^\/language$/, async (msg: Message) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, `🌐 ${LOCALE_TEXTS.en.prompts.language}\n${LOCALE_TEXTS.fa.prompts.language}`, {
    reply_markup: buildLanguageInlineKeyboard(),
  });
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
  const t = getTexts(user?.language);
  await bot.sendMessage(chatId, `${t.welcome}\n\n${t.chooseRole}`, {
    reply_markup: buildMainMenuKeyboard(Boolean(user?.mentorProfile), adminIds.has(telegramId), t),
  });
});

// ── Onboarding starters ───────────────────────────────────────────────────────

const startMentorOnboarding = async (msg: Message) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const state: UserState = { role: 'mentor', stepIndex: 0, profile: {}, selectedSkills: [], language: 'en' };
  userStates.set(telegramId, state);
  await showStep(chatId, 'language', 'mentor', telegramId);
};

const startMenteeOnboarding = async (msg: Message) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const state: UserState = { role: 'mentee', stepIndex: 0, profile: {}, selectedSkills: [], language: 'en' };
  userStates.set(telegramId, state);
  await showStep(chatId, 'language', 'mentee', telegramId);
};

bot.onText(menuButtonRegex('joinMentors'), startMentorOnboarding);
bot.onText(menuButtonRegex('needMentor'), startMenteeOnboarding);

// ── Menu action handlers ──────────────────────────────────────────────────────

const handleMatchRequest = async (msg: Message) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { menteeProfile: true } });
  const t = getTexts(user?.language);

  if (!user?.menteeProfile) { await bot.sendMessage(chatId, t.messages.completeMenteeProfile); return; }

  const mentors = await prisma.mentorProfile.findMany({ where: { availability: true } });
  const matches = findMentorMatches(
    { name: user.menteeProfile.name, skillsNeeded: user.menteeProfile.skillsNeeded, experienceYears: user.menteeProfile.experienceYears, location: user.menteeProfile.location, language: user.menteeProfile.language },
    mentors.map((m) => ({ id: m.id, name: m.name, skills: m.skills, experienceYears: m.experienceYears, location: m.location, availability: m.availability, language: m.language }))
  );

  if (!matches.length) {
    await bot.sendMessage(chatId, t.messages.noMentorsAvailable);
    for (const adminId of adminIds) {
      const adminUser = await prisma.user.findUnique({ where: { telegramId: adminId } });
      const at = getTexts(adminUser?.language);
      const notification = format(at.messages.manualMatchNeeded, {
        menteeName: user.menteeProfile.name,
        skills: user.menteeProfile.skillsNeeded.join(', ') || at.messages.notAvailable,
        experience: user.menteeProfile.experienceYears ?? 0,
        location: user.menteeProfile.location || at.messages.notAvailable,
      });
      await bot.sendMessage(Number(adminId), notification).catch(() => {});
    }
    return;
  }

  const topMatches = matches.slice(0, 3);
  let reply = t.messages.topMentorMatches + '\n';
  const inlineKeyboard = topMatches.map((m) => [{ text: `${t.messages.requestButtonPrefix} ${m.name}`, callback_data: `request:${m.id}` }]);
  for (const m of topMatches) {
    const displaySkills = m.skills.map((s) => translateOption(t.locale, s, 'skill')).join(', ');
    reply += `\n👤 ${m.name}\n${t.summary.skills}: ${displaySkills}\n${t.summary.experience}: ${format(t.summary.yearsLabel, { n: m.experienceYears })}\n${t.summary.location}: ${m.location || t.messages.notAvailable}\n${t.summary.language}: ${languageDisplayName(m.language)}\n`;
  }
  await bot.sendMessage(chatId, reply, { reply_markup: { inline_keyboard: inlineKeyboard } });
};

const handleSetBusy = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true } });
  const t = getTexts(user?.language);
  if (!user?.mentorProfile) { await bot.sendMessage(msg.chat.id, t.messages.needMentorProfile); return; }
  await prisma.mentorProfile.update({ where: { id: user.mentorProfile.id }, data: { availability: false } });
  await bot.sendMessage(msg.chat.id, t.messages.busySet);
};

const handleSetAvailable = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true } });
  const t = getTexts(user?.language);
  if (!user?.mentorProfile) { await bot.sendMessage(msg.chat.id, t.messages.needMentorProfile); return; }
  await prisma.mentorProfile.update({ where: { id: user.mentorProfile.id }, data: { availability: true } });
  await bot.sendMessage(msg.chat.id, t.messages.availableSet);
};

const handleHelp = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({ where: { telegramId } });
  const t = getTexts(user?.language);
  await bot.sendMessage(msg.chat.id, t.messages.helpText);
};

const handleAdminMentorsList = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  const admin = await prisma.user.findUnique({ where: { telegramId } });
  const t = getTexts(admin?.language);
  const mentors = await prisma.mentorProfile.findMany({ orderBy: { createdAt: 'asc' } });
  if (!mentors.length) { await bot.sendMessage(msg.chat.id, t.admin.noMentorsRegistered); return; }
  const lines = mentors.map((m, i) => [
    `${i + 1}. ${m.name} [${m.availability ? t.admin.available : t.admin.busy}]`,
    m.title ? `   ${t.summary.title}: ${translateOption(t.locale, m.title, 'title')}` : null,
    `   ${t.summary.skills}: ${m.skills.map((s) => translateOption(t.locale, s, 'skill')).join(', ')}`,
    `   ${t.summary.experience}: ${format(t.summary.yearsLabel, { n: m.experienceYears })}`,
    m.location ? `   ${t.summary.location}: ${m.location}` : null,
    `   ${t.summary.language}: ${languageDisplayName(m.language)}`,
    m.contactMethods.length ? `   ${t.summary.contact}: ${m.contactMethods.join(', ')}` : null,
  ].filter(Boolean).join('\n'));
  await bot.sendMessage(msg.chat.id, `${format(t.admin.mentorsListHeader, { count: mentors.length })}\n\n${lines.join('\n\n')}`);
};

const handleAdminMenteesList = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  const admin = await prisma.user.findUnique({ where: { telegramId } });
  const t = getTexts(admin?.language);
  const mentees = await prisma.menteeProfile.findMany({ orderBy: { createdAt: 'asc' } });
  if (!mentees.length) { await bot.sendMessage(msg.chat.id, t.admin.noMenteesRegistered); return; }
  const lines = mentees.map((m, i) => [
    `${i + 1}. ${m.name}`,
    `   ${t.summary.skills}: ${m.skillsNeeded.map((s) => translateOption(t.locale, s, 'skill')).join(', ')}`,
    m.experienceYears != null ? `   ${t.summary.experience}: ${format(t.summary.yearsLabel, { n: m.experienceYears })}` : null,
    m.location ? `   ${t.summary.location}: ${m.location}` : null,
    `   ${t.summary.language}: ${languageDisplayName(m.language)}`,
    m.goals ? `   ${t.summary.goals}: ${m.goals}` : null,
  ].filter(Boolean).join('\n'));
  await bot.sendMessage(msg.chat.id, `${format(t.admin.menteesListHeader, { count: mentees.length })}\n\n${lines.join('\n\n')}`);
};

const handleAdminRestart = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  const admin = await prisma.user.findUnique({ where: { telegramId } });
  const t = getTexts(admin?.language);
  await bot.sendMessage(msg.chat.id, t.admin.restarting);
  setTimeout(() => process.exit(0), 500);
};

// ── Callback query handler ────────────────────────────────────────────────────

bot.on('callback_query', async (callbackQuery) => {
  if (!callbackQuery.data) return;
  const data = callbackQuery.data as string;
  const chatId = callbackQuery.message?.chat.id;
  const telegramId = String(callbackQuery.from?.id);
  const state = userStates.get(telegramId);
  const t = getTexts(state?.language);

  await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});

  // ── Language selected (onboarding step 1, or standalone /language command) ──
  if (data.startsWith('language:')) {
    if (!chatId) return;
    const code = data.slice('language:'.length);
    if (!isLocale(code)) return;

    await prisma.user.upsert({
      where: { telegramId },
      update: { language: code },
      create: { telegramId, language: code },
    });

    const isOnboardingLanguageStep = !!state && ONBOARDING_STEPS[state.role][state.stepIndex] === 'language';
    if (state && isOnboardingLanguageStep) {
      state.language = code;
      state.stepIndex += 1;
      const nextStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string | undefined;
      if (!nextStep) { await finishOnboarding(chatId, telegramId, state); return; }
      await showStep(chatId, nextStep, state.role, telegramId);
      return;
    }

    const nt = getTexts(code);
    const messageId = callbackQuery.message?.message_id;
    if (messageId) {
      await bot.editMessageText(nt.messages.languageUpdated, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }
    return;
  }

  // ── Skill toggle ──
  if (data.startsWith('toggle_skill:')) {
    if (!state || !chatId) return;
    const skill = data.slice('toggle_skill:'.length);
    const idx = state.selectedSkills.indexOf(skill);
    if (idx === -1) state.selectedSkills.push(skill);
    else state.selectedSkills.splice(idx, 1);
    const skillOptions = await getSkillOptions();
    await bot.editMessageReplyMarkup(
      buildSkillsInlineKeyboard(skillOptions, state.selectedSkills, state.stepIndex > 0, t),
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
      await bot.sendMessage(chatId, t.messages.sessionExpired);
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
      telegram: t.prompts.contactTelegram,
      phone: t.prompts.contactPhone,
      email: t.prompts.contactEmail,
    };
    await bot.editMessageText(prompts[contactType], {
      chat_id: chatId,
      message_id: state.currentMessageId,
      reply_markup: { inline_keyboard: [[{ text: t.ui.back, callback_data: 'contact_back_to_types' }]] },
    }).catch(() => {});
    return;
  }

  // ── Back from contact entry to type selector ──
  if (data === 'contact_back_to_types') {
    if (!state || !chatId) return;
    state.awaitingContactType = undefined;
    const collected = state.contactMethods || {};
    const labels = getContactLabels(state.language);
    const collectedStr = renderCollectedContacts(collected, labels);
    const prompt = collectedStr
      ? `${collectedStr}\n\n${t.messages.addAnotherContact}`
      : t.prompts.contact;
    await bot.editMessageText(prompt, {
      chat_id: chatId,
      message_id: state.currentMessageId,
      reply_markup: buildContactTypeKeyboard(collected, state.stepIndex > 0, labels, { back: t.ui.back, done: t.ui.done }),
    }).catch(() => {});
    return;
  }

  // ── Contact done ──
  if (data === 'contact_done') {
    if (!state || !chatId) return;
    const collected = state.contactMethods || {};
    if (Object.keys(collected).length === 0) {
      await bot.sendMessage(chatId, t.messages.addAtLeastOneContact);
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
    await bot.editMessageText(t.prompts.experienceMonth, {
      chat_id: chatId,
      message_id: state.currentMessageId,
      reply_markup: buildMonthKeyboard(year, t),
    });
    return;
  }

  // ── Back to years from month ──
  if (data === 'back_to_years') {
    if (!state || !chatId) return;
    state.awaitingSubStep = 'year';
    delete state.profile.startYear;
    await bot.editMessageText(t.prompts.experience, {
      chat_id: chatId,
      message_id: state.currentMessageId,
      reply_markup: buildYearKeyboard(state.stepIndex > 0, t),
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
      await bot.editMessageText(`${t.summary.careerStart}: ${monthName} ${year}`, {
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
    const mt = getTexts(mentee?.language);
    if (!mentee?.menteeProfile) { if (chatId) await bot.sendMessage(chatId, mt.messages.completeMenteeProfile); return; }
    const mentor = await prisma.mentorProfile.findUnique({ where: { id: mentorId } });
    if (!mentor) { if (chatId) await bot.sendMessage(chatId, mt.messages.mentorNotFound); return; }
    const mentorUser = await prisma.user.findUnique({ where: { id: mentor.userId } });
    if (!mentorUser) { if (chatId) await bot.sendMessage(chatId, mt.messages.mentorUserNotFound); return; }

    const existingRequest = await prisma.mentorshipRequest.findFirst({
      where: {
        mentorProfileId: mentor.id,
        menteeProfileId: mentee.menteeProfile.id,
        status: 'PENDING',
      },
    });
    if (existingRequest) {
      if (chatId) await bot.sendMessage(chatId, mt.messages.alreadyRequested);
      return;
    }

    await prisma.mentorshipRequest.create({
      data: {
        mentorProfileId: mentor.id,
        menteeProfileId: mentee.menteeProfile.id,
      },
    });

    if (chatId) await bot.sendMessage(chatId, format(mt.messages.requestSent, { mentorName: mentor.name }));
    const rt = getTexts(mentorUser.language);
    await bot.sendMessage(
      Number(mentorUser.telegramId),
      format(rt.messages.requestNew, { menteeName: mentee.menteeProfile.name, menteeId: mentee.menteeProfile.id }),
      { reply_markup: { inline_keyboard: [[{ text: rt.actions.accept, callback_data: `accept:${mentee.menteeProfile.id}` }, { text: rt.actions.decline, callback_data: `decline:${mentee.menteeProfile.id}` }]] } }
    );
    return;
  }

  // ── Accept / Decline ──
  if (data.startsWith('accept:') || data.startsWith('decline:')) {
    const [action, menteeProfileIdStr] = data.split(':');
    const menteeProfileId = Number(menteeProfileIdStr);
    const mentorUser = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true } });
    const mt = getTexts(mentorUser?.language);
    if (!mentorUser?.mentorProfile) { if (chatId) await bot.sendMessage(chatId, mt.messages.needMentorProfile); return; }

    const request = await prisma.mentorshipRequest.findFirst({
      where: {
        mentorProfileId: mentorUser.mentorProfile.id,
        menteeProfileId,
        status: 'PENDING',
      },
    });
    if (!request) { if (chatId) await bot.sendMessage(chatId, mt.messages.noPendingRequest); return; }

    await prisma.mentorshipRequest.update({
      where: { id: request.id },
      data: { status: action === 'accept' ? 'ACCEPTED' : 'DECLINED' },
    });

    const menteeProfile = await prisma.menteeProfile.findUnique({ where: { id: menteeProfileId }, include: { user: true } });
    if (action === 'accept') {
      if (chatId) await bot.sendMessage(chatId, mt.messages.requestAccepted);
      if (menteeProfile?.user) {
        const rt = getTexts(menteeProfile.user.language);
        await bot.sendMessage(Number(menteeProfile.user.telegramId), rt.messages.acceptedNotification);
      }
    } else {
      if (chatId) await bot.sendMessage(chatId, mt.messages.requestDeclined);
      if (menteeProfile?.user) {
        const rt = getTexts(menteeProfile.user.language);
        await bot.sendMessage(Number(menteeProfile.user.telegramId), rt.messages.declinedNotification);
      }
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
    if (matchesMenuButton(text, 'busy')) { await handleSetBusy(msg); return; }
    if (matchesMenuButton(text, 'available')) { await handleSetAvailable(msg); return; }
    if (matchesMenuButton(text, 'help')) { await handleHelp(msg); return; }
    if (matchesMenuButton(text, 'adminMentors')) { await handleAdminMentorsList(msg); return; }
    if (matchesMenuButton(text, 'adminMentees')) { await handleAdminMenteesList(msg); return; }
    if (matchesMenuButton(text, 'adminRestart')) { await handleAdminRestart(msg); return; }
    return;
  }

  const t = getTexts(state.language);

  // Inline keyboard steps — reject freetext
  if (state.awaitingSubStep === 'year' || state.awaitingSubStep === 'month') {
    await bot.sendMessage(chatId, t.messages.useButtons);
    return;
  }

  // Normal text step
  const currentStep = ONBOARDING_STEPS[state.role][state.stepIndex] as OnboardingStep;

  // Contact step: awaiting a typed value for a chosen contact type
  if (currentStep === 'contact') {
    if (!state.awaitingContactType) {
      // No type chosen yet — nudge to use buttons
      await bot.sendMessage(chatId, t.messages.useButtons);
      return;
    }
    if (state.awaitingContactType === 'email' && !isValidEmail(text)) {
      await bot.sendMessage(chatId, t.messages.invalidEmail);
      return;
    }
    if (!state.contactMethods) state.contactMethods = {};
    state.contactMethods[state.awaitingContactType] = text;
    state.awaitingContactType = undefined;
    const collected = state.contactMethods;
    const labels = getContactLabels(state.language);
    const all: ContactType[] = ['telegram', 'phone', 'email'];
    const remaining = all.filter((ct) => !collected[ct]);
    const collectedStr = renderCollectedContacts(collected, labels);
    const prompt = remaining.length > 0
      ? `${collectedStr}\n\n${t.messages.addAnotherContact}`
      : `${collectedStr}\n\n${t.messages.allContactMethodsAdded}`;
    try {
      await bot.editMessageText(prompt, {
        chat_id: chatId,
        message_id: state.currentMessageId,
        reply_markup: buildContactTypeKeyboard(collected, state.stepIndex > 0, labels, { back: t.ui.back, done: t.ui.done }),
      });
    } catch {
      const sent = await bot.sendMessage(chatId, prompt, {
        reply_markup: buildContactTypeKeyboard(collected, state.stepIndex > 0, labels, { back: t.ui.back, done: t.ui.done }),
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
    const markup = buildSkillsInlineKeyboard(skillOpts, state.selectedSkills, state.stepIndex > 0, t);
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
