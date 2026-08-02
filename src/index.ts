import dotenv from 'dotenv';
import express from 'express';
import TelegramBot, { type Message } from 'node-telegram-bot-api';
import { PrismaClient, Prisma } from '@prisma/client';
import { findMentorMatches, canonicalizeSkill } from './matching.js';
import { getTexts, LOCALE_TEXTS, LANGUAGE_CHOICES, isLocale, type Locale, type Texts } from './i18n/index.js';
import { translateOption, getContactLabels } from './i18n/labels.js';
import { SKILL_OPTIONS } from './i18n/options.js';
import { matchesMenuButton, menuButtonRegex } from './i18n/menuButtons.js';
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

function renderCollectedContacts(collected: Partial<Record<ContactType, string>>, labels: Record<ContactType, string>): string {
  return (Object.keys(collected) as ContactType[])
    .map((ct) => `✅ ${labels[ct]}: ${collected[ct]}`)
    .join('\n');
}

function languageDisplayName(code: string): string {
  return LANGUAGE_CHOICES.find((l) => l.code === code)?.label ?? code;
}

const CONTACT_FIELD_BY_TYPE: Record<ContactType, 'telegramContact' | 'phoneContact' | 'emailContact'> = {
  telegram: 'telegramContact',
  phone: 'phoneContact',
  email: 'emailContact',
};

// Telegram ID/phone/email must be unique per mentor. Checked here (as the value is
// typed) rather than only relying on the DB constraint, so a conflict is caught
// immediately with a clear message instead of surfacing at finishOnboarding as a
// generic error. Excludes the current user's own profile so re-onboarding with an
// unchanged value isn't flagged as a conflict with themselves.
async function isContactValueTaken(type: ContactType, value: string, currentTelegramId: string): Promise<boolean> {
  const field = CONTACT_FIELD_BY_TYPE[type];
  const existing = await prisma.mentorProfile.findFirst({
    where: { [field]: value, user: { telegramId: { not: currentTelegramId } } },
  });
  return !!existing;
}

// Records every profile create/update/delete for the admin /history command.
// `actor` is the acting telegramId for self-edits, or the literal string 'admin'
// for admin-initiated edits/deletes, so history can distinguish the two.
async function logProfileAudit(
  telegramId: string,
  role: 'MENTOR' | 'MENTEE',
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  actor: string,
  snapshot: unknown
) {
  await prisma.profileAuditLog.create({
    data: { telegramId, role, action, actor, snapshot: snapshot as Prisma.InputJsonValue },
  });
}

// ── Inline keyboard builders ──────────────────────────────────────────────────

async function getSkillOptions(): Promise<string[]> {
  const [mentors, mentees] = await Promise.all([
    prisma.mentorProfile.findMany({ select: { skills: true } }),
    prisma.menteeProfile.findMany({ select: { skillsNeeded: true } }),
  ]);
  const seenSkills = [...new Set([
    ...mentors.flatMap((m) => m.skills),
    ...mentees.flatMap((m) => m.skillsNeeded),
  ])];
  const base = SKILL_OPTIONS.filter((s) => s !== 'Other');
  const combined = [...base];
  for (const s of seenSkills) {
    if (!combined.some((o) => canonicalizeSkill(o) === canonicalizeSkill(s))) {
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
  const custom = selected.filter((s) => !options.some((o) => canonicalizeSkill(o) === canonicalizeSkill(s)));
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

function buildMainMenuKeyboard(isMentor: boolean, hasProfile: boolean, isAdmin: boolean, t: Texts) {
  const keyboard: Array<Array<{ text: string }>> = [];
  keyboard.push([{ text: t.startMenu.joinMentors }, { text: t.startMenu.needMentor }]);
  if (isMentor) {
    keyboard.push([{ text: t.startMenu.busy }, { text: t.startMenu.available }]);
  }
  if (hasProfile) {
    keyboard.push([{ text: t.startMenu.editProfile }]);
  }
  if (isAdmin) {
    keyboard.push([{ text: t.startMenu.adminMentors }, { text: t.startMenu.adminMentees }]);
    keyboard.push([{ text: t.startMenu.adminRestart }]);
  }
  keyboard.push([{ text: t.startMenu.help }]);
  return { keyboard, resize_keyboard: true };
}

function buildBusyDurationKeyboard(t: Texts, includeAvailableNow = false) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  if (includeAvailableNow) {
    rows.push([{ text: t.busyFlow.availableNow, callback_data: 'busy_set:available_now' }]);
  }
  rows.push([{ text: t.busyFlow.indefinite, callback_data: 'busy_set:indefinite' }]);
  rows.push([{ text: t.busyFlow.askLater, callback_data: 'busy_set:later' }]);
  rows.push([{ text: t.busyFlow.pickDate, callback_data: 'busy_set:pickdate' }]);
  return { inline_keyboard: rows };
}

function buildBusyDatePresetsKeyboard(t: Texts) {
  return {
    inline_keyboard: [
      [{ text: t.busyFlow.oneWeek, callback_data: 'busy_set:days:7' }, { text: t.busyFlow.twoWeeks, callback_data: 'busy_set:days:14' }],
      [{ text: t.busyFlow.oneMonth, callback_data: 'busy_set:days:30' }, { text: t.busyFlow.threeMonths, callback_data: 'busy_set:days:90' }],
      [{ text: t.ui.back, callback_data: 'busy_set:back' }],
    ],
  };
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

  const existingUser = await prisma.user.findUnique({
    where: { telegramId },
    include: { mentorProfile: true, menteeProfile: true },
  });
  const hadProfileBefore = state.role === 'mentor' ? !!existingUser?.mentorProfile : !!existingUser?.menteeProfile;

  const mentorData = {
    name: state.profile.name || 'Mentor',
    title: state.profile.title || null,
    skills: (state.profile.skills || '').split(',').map((s) => s.trim()).filter(Boolean),
    experienceYears,
    country: state.profile.country || null,
    city: state.profile.city || null,
    location,
    contactMethods,
    telegramContact: state.contactMethods?.telegram || null,
    phoneContact: state.contactMethods?.phone || null,
    emailContact: state.contactMethods?.email || null,
    language: state.language,
  };

  const menteeData = {
    name: state.profile.name || 'Mentee',
    goals: state.profile.goals || null,
    skillsNeeded: (state.profile.skills || '').split(',').map((s) => s.trim()).filter(Boolean),
    experienceYears,
    country: state.profile.country || null,
    city: state.profile.city || null,
    location,
    language: state.language,
  };

  try {
    await prisma.user.upsert({
      where: { telegramId },
      // A user re-running onboarding already has a MentorProfile/MenteeProfile
      // (one-to-one relation) — nested `create` would throw P2014 and crash the
      // whole process, so update uses nested `upsert` instead. Only a brand-new
      // User row (the `create` branch below) can use a plain nested `create`.
      update: {
        role,
        language: state.language,
        ...(state.role === 'mentor'
          ? { mentorProfile: { upsert: { create: mentorData, update: mentorData } } }
          : { menteeProfile: { upsert: { create: menteeData, update: menteeData } } }),
      },
      // Use upsert, not update: a user who taps "Become Mentor"/"Find Mentor" without
      // ever sending /start first (e.g. from a stale keyboard after a bot restart) has
      // no User row yet, and update() would throw P2025 and crash the whole process.
      create: {
        telegramId,
        role,
        language: state.language,
        ...(state.role === 'mentor' ? { mentorProfile: { create: mentorData } } : { menteeProfile: { create: menteeData } }),
      },
    });
  } catch (err: unknown) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      await bot.sendMessage(chatId, t.messages.contactAlreadyTaken);
      return;
    }
    throw err;
  }

  await logProfileAudit(
    telegramId,
    role,
    hadProfileBefore ? 'UPDATE' : 'CREATE',
    telegramId,
    state.role === 'mentor' ? mentorData : menteeData
  );

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

  // Show the completion summary — edit the tracked message if possible, but always
  // fall back to a fresh message so the summary is never silently dropped.
  const readyText = `${format(t.profileReady, { role: roleText })}\n\n${summary}`;
  let summaryShown = false;
  if (state.currentMessageId) {
    try {
      await bot.editMessageText(readyText, {
        chat_id: chatId,
        message_id: state.currentMessageId,
        reply_markup: { inline_keyboard: [] },
      });
      summaryShown = true;
    } catch (err) {
      console.error('finishOnboarding: failed to edit summary message:', err);
    }
  }
  if (!summaryShown) {
    await bot.sendMessage(chatId, readyText);
  }

  // Shown once, on first-time onboarding only — not on every profile edit.
  if (isMentorNow && !hadProfileBefore) {
    await bot.sendMessage(chatId, t.messages.mentorWelcome);
  }

  await bot.sendMessage(chatId, t.chooseRole, {
    reply_markup: buildMainMenuKeyboard(isMentorNow, true, adminIds.has(telegramId), t),
  });

  // A mentee finishing onboarding almost certainly wants to see matches right
  // away rather than tapping Find Mentor again immediately afterward.
  if (!isMentorNow) {
    await searchMentorsForMentee(chatId, telegramId);
  }
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

// Run this inside the target group (with the bot already a member) to get the
// numeric chat ID needed for MENTORS_GROUP_CHAT_ID — invite links can't be
// resolved to a chat ID via the Bot API.
bot.onText(/^\/groupid$/, async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  await bot.sendMessage(msg.chat.id, `Chat ID: ${msg.chat.id}`);
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

bot.onText(/^\/history$/, async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  const admin = await prisma.user.findUnique({ where: { telegramId } });
  const t = getTexts(admin?.language);

  const entries = await prisma.profileAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
  if (!entries.length) { await bot.sendMessage(msg.chat.id, t.admin.noHistory); return; }

  const actionLabel = (action: string) =>
    action === 'CREATE' ? t.admin.actionCreate : action === 'UPDATE' ? t.admin.actionUpdate : t.admin.actionDelete;

  const lines = entries.map((entry, i) => {
    const snapshot = entry.snapshot as Record<string, unknown>;
    const detail = typeof snapshot.name === 'string'
      ? snapshot.name
      : typeof snapshot.field === 'string'
        ? `${snapshot.field}: ${JSON.stringify(snapshot.oldValue)} → ${JSON.stringify(snapshot.newValue)}`
        : '';
    const actorNote = entry.actor === 'admin' ? ` ${t.admin.byAdmin}` : '';
    return `${i + 1}. ${actionLabel(entry.action)} — ${entry.role} ${entry.telegramId}${detail ? ` — ${detail}` : ''}${actorNote}\n   ${entry.createdAt.toISOString()}`;
  });

  await bot.sendMessage(msg.chat.id, `${format(t.admin.historyHeader, { count: entries.length })}\n\n${lines.join('\n\n')}`);
});

bot.onText(/^\/deletementor\s+(\d+)\s*$/, async (msg: Message, match: RegExpMatchArray | null) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  const admin = await prisma.user.findUnique({ where: { telegramId } });
  const t = getTexts(admin?.language);
  const id = Number(match?.[1]);

  const profile = await prisma.mentorProfile.findUnique({ where: { id }, include: { user: true } });
  if (!profile) { await bot.sendMessage(msg.chat.id, t.admin.profileNotFound); return; }

  await logProfileAudit(profile.user.telegramId, 'MENTOR', 'DELETE', 'admin', profile);
  await prisma.mentorProfile.delete({ where: { id } });
  await bot.sendMessage(msg.chat.id, format(t.admin.mentorDeleted, { id }));
});

bot.onText(/^\/deletementee\s+(\d+)\s*$/, async (msg: Message, match: RegExpMatchArray | null) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  const admin = await prisma.user.findUnique({ where: { telegramId } });
  const t = getTexts(admin?.language);
  const id = Number(match?.[1]);

  const profile = await prisma.menteeProfile.findUnique({ where: { id }, include: { user: true } });
  if (!profile) { await bot.sendMessage(msg.chat.id, t.admin.profileNotFound); return; }

  await logProfileAudit(profile.user.telegramId, 'MENTEE', 'DELETE', 'admin', profile);
  await prisma.menteeProfile.delete({ where: { id } });
  await bot.sendMessage(msg.chat.id, format(t.admin.menteeDeleted, { id }));
});

bot.onText(/^\/deletementor\s*$/, async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  const admin = await prisma.user.findUnique({ where: { telegramId } });
  await bot.sendMessage(msg.chat.id, getTexts(admin?.language).admin.deleteMentorUsage);
});

bot.onText(/^\/deletementee\s*$/, async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  const admin = await prisma.user.findUnique({ where: { telegramId } });
  await bot.sendMessage(msg.chat.id, getTexts(admin?.language).admin.deleteMenteeUsage);
});

const MENTOR_EDITABLE_FIELDS = ['name', 'title', 'skills', 'experienceYears', 'country', 'city', 'availability', 'telegramContact', 'phoneContact', 'emailContact'] as const;
const MENTEE_EDITABLE_FIELDS = ['name', 'goals', 'skillsNeeded', 'experienceYears', 'country', 'city'] as const;

bot.onText(/^\/editmentor(?:\s+([\s\S]+))?$/, async (msg: Message, match: RegExpMatchArray | null) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  const chatId = msg.chat.id;
  const admin = await prisma.user.findUnique({ where: { telegramId } });
  const t = getTexts(admin?.language);

  const args = match?.[1]?.match(/^(\d+)\s+(\S+)\s+([\s\S]+)$/);
  if (!args) { await bot.sendMessage(chatId, t.admin.editMentorUsage); return; }
  const [, idStr, field, rawValue] = args;
  const id = Number(idStr);

  if (!(MENTOR_EDITABLE_FIELDS as readonly string[]).includes(field)) {
    await bot.sendMessage(chatId, format(t.admin.unknownField, { field }));
    return;
  }

  const profile = await prisma.mentorProfile.findUnique({ where: { id }, include: { user: true } });
  if (!profile) { await bot.sendMessage(chatId, t.admin.profileNotFound); return; }

  let value: string | number | boolean | string[];
  if (field === 'experienceYears') {
    const n = Number(rawValue);
    if (!Number.isFinite(n) || n < 0) { await bot.sendMessage(chatId, format(t.admin.invalidFieldValue, { field })); return; }
    value = n;
  } else if (field === 'availability') {
    if (!['true', 'false'].includes(rawValue.toLowerCase())) { await bot.sendMessage(chatId, format(t.admin.invalidFieldValue, { field })); return; }
    value = rawValue.toLowerCase() === 'true';
  } else if (field === 'skills') {
    value = rawValue.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (field === 'telegramContact' || field === 'phoneContact' || field === 'emailContact') {
    if (field === 'emailContact' && !isValidEmail(rawValue)) { await bot.sendMessage(chatId, t.messages.invalidEmail); return; }
    const taken = await prisma.mentorProfile.findFirst({ where: { [field]: rawValue, id: { not: id } } });
    if (taken) { await bot.sendMessage(chatId, t.admin.contactFieldTaken); return; }
    value = rawValue;
  } else {
    value = rawValue;
  }

  const oldValue = (profile as unknown as Record<string, unknown>)[field];
  await prisma.mentorProfile.update({ where: { id }, data: { [field]: value } });
  await logProfileAudit(profile.user.telegramId, 'MENTOR', 'UPDATE', 'admin', { field, oldValue, newValue: value });
  await bot.sendMessage(chatId, format(t.admin.fieldUpdated, { field, id }));
});

bot.onText(/^\/editmentee(?:\s+([\s\S]+))?$/, async (msg: Message, match: RegExpMatchArray | null) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  const chatId = msg.chat.id;
  const admin = await prisma.user.findUnique({ where: { telegramId } });
  const t = getTexts(admin?.language);

  const args = match?.[1]?.match(/^(\d+)\s+(\S+)\s+([\s\S]+)$/);
  if (!args) { await bot.sendMessage(chatId, t.admin.editMenteeUsage); return; }
  const [, idStr, field, rawValue] = args;
  const id = Number(idStr);

  if (!(MENTEE_EDITABLE_FIELDS as readonly string[]).includes(field)) {
    await bot.sendMessage(chatId, format(t.admin.unknownField, { field }));
    return;
  }

  const profile = await prisma.menteeProfile.findUnique({ where: { id }, include: { user: true } });
  if (!profile) { await bot.sendMessage(chatId, t.admin.profileNotFound); return; }

  let value: string | number | string[];
  if (field === 'experienceYears') {
    const n = Number(rawValue);
    if (!Number.isFinite(n) || n < 0) { await bot.sendMessage(chatId, format(t.admin.invalidFieldValue, { field })); return; }
    value = n;
  } else if (field === 'skillsNeeded') {
    value = rawValue.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    value = rawValue;
  }

  const oldValue = (profile as unknown as Record<string, unknown>)[field];
  await prisma.menteeProfile.update({ where: { id }, data: { [field]: value } });
  await logProfileAudit(profile.user.telegramId, 'MENTEE', 'UPDATE', 'admin', { field, oldValue, newValue: value });
  await bot.sendMessage(chatId, format(t.admin.fieldUpdated, { field, id }));
});

bot.onText(/\/start/, async (msg: Message) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);

  await prisma.user.upsert({
    where: { telegramId },
    update: { firstName: msg.from?.first_name || null, lastName: msg.from?.last_name || null, username: msg.from?.username || null },
    create: { telegramId, firstName: msg.from?.first_name || null, lastName: msg.from?.last_name || null, username: msg.from?.username || null },
  });

  const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true, menteeProfile: true } });
  const t = getTexts(user?.language);
  await bot.sendMessage(chatId, `${t.welcome}\n\n${t.chooseRole}`, {
    reply_markup: buildMainMenuKeyboard(Boolean(user?.mentorProfile), Boolean(user?.mentorProfile || user?.menteeProfile), adminIds.has(telegramId), t),
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

const startOrSearchMentee = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { menteeProfile: true } });
  if (user?.menteeProfile) { await searchMentorsForMentee(msg.chat.id, telegramId); return; }
  await startMenteeOnboarding(msg);
};

bot.onText(menuButtonRegex('joinMentors'), startMentorOnboarding);
bot.onText(menuButtonRegex('needMentor'), startOrSearchMentee);

// ── Menu action handlers ──────────────────────────────────────────────────────

const MIN_EXPLANATION_LENGTH = 50;
const MAX_EXPLANATION_LENGTH = 500;
// telegramIds currently being asked to explain what kind of mentor they need,
// after an automatic search found nobody with a relevant skill/title.
const pendingMentorExplanation = new Set<string>();

async function searchMentorsForMentee(chatId: number, telegramId: string) {
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { menteeProfile: true } });
  const t = getTexts(user?.language);

  if (!user?.menteeProfile) { await bot.sendMessage(chatId, t.messages.completeMenteeProfile); return; }

  const mentors = await prisma.mentorProfile.findMany({ where: { availability: true } });
  const matches = findMentorMatches(
    { name: user.menteeProfile.name, skillsNeeded: user.menteeProfile.skillsNeeded, experienceYears: user.menteeProfile.experienceYears, location: user.menteeProfile.location, language: user.menteeProfile.language },
    mentors.map((m) => ({ id: m.id, name: m.name, title: m.title, skills: m.skills, experienceYears: m.experienceYears, location: m.location, availability: m.availability, language: m.language }))
  );

  // Every available mentor is always returned by findMentorMatches (it only
  // sorts, never filters by relevance), so "no options" means none of them
  // share any skill/title with what this mentee is looking for — not
  // literally zero mentors registered.
  const relevantMatches = matches.filter((m) => m.overlap > 0);

  if (!relevantMatches.length) {
    await bot.sendMessage(chatId, t.messages.noMentorsAvailable);
    pendingMentorExplanation.add(telegramId);
    await bot.sendMessage(chatId, format(t.messages.askMentorExplanation, {
      min: MIN_EXPLANATION_LENGTH,
      max: MAX_EXPLANATION_LENGTH,
    }));
    return;
  }

  const topMatches = relevantMatches.slice(0, 3);
  let reply = t.messages.topMentorMatches + '\n';
  const inlineKeyboard = topMatches.map((m) => [{ text: `${t.messages.requestButtonPrefix} ${m.name}`, callback_data: `request:${m.id}` }]);
  for (const m of topMatches) {
    const displaySkills = m.skills.map((s) => translateOption(t.locale, s, 'skill')).join(', ');
    reply += `\n👤 ${m.name}\n${t.summary.skills}: ${displaySkills}\n${t.summary.experience}: ${format(t.summary.yearsLabel, { n: m.experienceYears })}\n${t.summary.location}: ${m.location || t.messages.notAvailable}\n${t.summary.language}: ${languageDisplayName(m.language)}\n`;
  }
  await bot.sendMessage(chatId, reply, { reply_markup: { inline_keyboard: inlineKeyboard } });
}

type MenteeProfileForGroupPost = {
  name: string;
  skillsNeeded: string[];
  experienceYears: number | null;
  location: string | null;
  language: string;
};

async function postMentorSearchRequestToGroup(
  requestId: number,
  menteeProfile: MenteeProfileForGroupPost,
  explanation: string,
  isReminder = false
) {
  const groupChatId = process.env.MENTORS_GROUP_CHAT_ID;
  if (!groupChatId) {
    console.error('MENTORS_GROUP_CHAT_ID is not set — skipping group post. Run /groupid in the target group to get its ID.');
    return;
  }
  const t = getTexts(menteeProfile.language);
  const body = format(t.messages.mentorSearchGroupPost, {
    menteeName: menteeProfile.name,
    skills: menteeProfile.skillsNeeded.join(', ') || t.messages.notAvailable,
    experience: menteeProfile.experienceYears ?? 0,
    location: menteeProfile.location || t.messages.notAvailable,
    language: languageDisplayName(menteeProfile.language),
    explanation,
  });
  const post = isReminder ? `${t.messages.reminderBumpPrefix}\n\n${body}` : body;
  await bot.sendMessage(Number(groupChatId), post, {
    reply_markup: { inline_keyboard: [[{ text: t.messages.claimButtonText, callback_data: `claim_search:${requestId}` }]] },
  }).catch((err) => console.error('Failed to post to mentors group:', err));
}

async function handleMentorExplanationText(msg: Message) {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);
  const text = (msg.text || '').trim();
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { menteeProfile: true } });
  const t = getTexts(user?.language);

  if (text.length < MIN_EXPLANATION_LENGTH) {
    await bot.sendMessage(chatId, format(t.messages.explanationTooShort, { min: MIN_EXPLANATION_LENGTH, current: text.length }));
    return;
  }
  if (text.length > MAX_EXPLANATION_LENGTH) {
    await bot.sendMessage(chatId, format(t.messages.explanationTooLong, { max: MAX_EXPLANATION_LENGTH, current: text.length }));
    return;
  }

  pendingMentorExplanation.delete(telegramId);
  if (!user?.menteeProfile) return;

  const request = await prisma.mentorSearchRequest.create({
    data: { menteeProfileId: user.menteeProfile.id, explanation: text },
  });
  await postMentorSearchRequestToGroup(request.id, user.menteeProfile, text);

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

  await bot.sendMessage(chatId, t.messages.explanationSentConfirmation);
}

const handleSetBusy = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true } });
  const t = getTexts(user?.language);
  if (!user?.mentorProfile) { await bot.sendMessage(msg.chat.id, t.messages.needMentorProfile); return; }
  await bot.sendMessage(msg.chat.id, t.busyFlow.prompt, { reply_markup: buildBusyDurationKeyboard(t) });
};

const handleSetAvailable = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true } });
  const t = getTexts(user?.language);
  if (!user?.mentorProfile) { await bot.sendMessage(msg.chat.id, t.messages.needMentorProfile); return; }
  await prisma.mentorProfile.update({ where: { id: user.mentorProfile.id }, data: { availability: true, busyUntil: null } });
  await bot.sendMessage(msg.chat.id, t.messages.availableSet);
};

const handleHelp = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({ where: { telegramId } });
  const t = getTexts(user?.language);
  await bot.sendMessage(msg.chat.id, t.messages.helpText);
};

// Re-runs the same onboarding flow the user already completed — finishOnboarding
// now upserts the existing profile rather than crashing, so this doubles as "edit".
const handleEditProfile = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true, menteeProfile: true } });
  if (user?.mentorProfile) { await startMentorOnboarding(msg); return; }
  if (user?.menteeProfile) { await startMenteeOnboarding(msg); return; }
  const t = getTexts(user?.language);
  await bot.sendMessage(msg.chat.id, t.messages.noProfileYet);
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

  // ── Mentor claims an unmatched mentee's search request from the group ──
  if (data.startsWith('claim_search:')) {
    if (!chatId) return;
    const requestId = Number(data.slice('claim_search:'.length));
    const request = await prisma.mentorSearchRequest.findUnique({
      where: { id: requestId },
      include: { menteeProfile: { include: { user: true } } },
    });
    if (!request) return;

    if (request.claimed) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Already claimed', show_alert: true }).catch(() => {});
      return;
    }

    await prisma.mentorSearchRequest.update({
      where: { id: requestId },
      data: { claimed: true, claimedByTelegramId: telegramId },
    });

    const menteeT = getTexts(request.menteeProfile.user.language);
    await bot.sendMessage(Number(request.menteeProfile.user.telegramId), menteeT.messages.mentorClaimedNotification).catch(() => {});

    const messageId = callbackQuery.message?.message_id;
    if (messageId) {
      const groupT = getTexts(request.menteeProfile.language);
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: groupT.messages.claimedMarker, callback_data: 'noop' }]] },
        { chat_id: chatId, message_id: messageId }
      ).catch(() => {});
    }
    return;
  }

  // ── Busy duration selection (Set Busy flow, or the busy-reminder prompt) ──
  if (data.startsWith('busy_set:')) {
    if (!chatId) return;
    const mentorUser = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true } });
    if (!mentorUser?.mentorProfile) return;
    const mt = getTexts(mentorUser.language);
    const action = data.slice('busy_set:'.length);
    const messageId = callbackQuery.message?.message_id;

    if (action === 'pickdate') {
      if (messageId) {
        await bot.editMessageText(mt.busyFlow.prompt, { chat_id: chatId, message_id: messageId, reply_markup: buildBusyDatePresetsKeyboard(mt) }).catch(() => {});
      }
      return;
    }
    if (action === 'back') {
      if (messageId) {
        await bot.editMessageText(mt.busyFlow.prompt, { chat_id: chatId, message_id: messageId, reply_markup: buildBusyDurationKeyboard(mt) }).catch(() => {});
      }
      return;
    }
    if (action === 'available_now') {
      await prisma.mentorProfile.update({ where: { id: mentorUser.mentorProfile.id }, data: { availability: true, busyUntil: null } });
      await bot.sendMessage(chatId, mt.messages.availableSet);
      return;
    }

    let busyUntil: Date | null = null;
    if (action === 'later') {
      busyUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    } else if (action.startsWith('days:')) {
      const days = Number(action.slice('days:'.length));
      busyUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    }
    // action === 'indefinite' leaves busyUntil as null — no scheduled reminder

    await prisma.mentorProfile.update({ where: { id: mentorUser.mentorProfile.id }, data: { availability: false, busyUntil } });
    await bot.sendMessage(chatId, mt.messages.busySet);
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
    if (pendingMentorExplanation.has(telegramId)) { await handleMentorExplanationText(msg); return; }
    if (matchesMenuButton(text, 'busy')) { await handleSetBusy(msg); return; }
    if (matchesMenuButton(text, 'available')) { await handleSetAvailable(msg); return; }
    if (matchesMenuButton(text, 'editProfile')) { await handleEditProfile(msg); return; }
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
    const labels = getContactLabels(state.language);
    if (await isContactValueTaken(state.awaitingContactType, text, telegramId)) {
      await bot.sendMessage(chatId, format(t.messages.contactTaken, { contactType: labels[state.awaitingContactType] }));
      return;
    }
    if (!state.contactMethods) state.contactMethods = {};
    state.contactMethods[state.awaitingContactType] = text;
    state.awaitingContactType = undefined;
    const collected = state.contactMethods;
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
      if (!state.selectedSkills.some((existing) => canonicalizeSkill(existing) === canonicalizeSkill(s))) {
        state.selectedSkills.push(s);
      }
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

// ── Background schedulers ─────────────────────────────────────────────────────

const BUSY_REMINDER_CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly
const STALE_SEARCH_REQUEST_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const STALE_SEARCH_REQUEST_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

async function checkBusyReminders() {
  const dueMentors = await prisma.mentorProfile.findMany({
    where: { availability: false, busyUntil: { lte: new Date() } },
    include: { user: true },
  });
  for (const mentor of dueMentors) {
    const t = getTexts(mentor.language);
    await bot.sendMessage(Number(mentor.user.telegramId), t.busyFlow.reminderPrompt, {
      reply_markup: buildBusyDurationKeyboard(t, true),
    }).catch((err) => console.error('Failed to send busy reminder:', err));
    // Clear busyUntil so this mentor isn't re-prompted on every check until they respond.
    await prisma.mentorProfile.update({ where: { id: mentor.id }, data: { busyUntil: null } });
  }
}

async function checkUnclaimedMentorSearchRequests() {
  const staleCutoff = new Date(Date.now() - STALE_SEARCH_REQUEST_AGE_MS);
  const staleRequests = await prisma.mentorSearchRequest.findMany({
    where: { claimed: false, lastPostedAt: { lte: staleCutoff } },
    include: { menteeProfile: true },
  });
  for (const request of staleRequests) {
    await postMentorSearchRequestToGroup(request.id, request.menteeProfile, request.explanation, true);
    await prisma.mentorSearchRequest.update({ where: { id: request.id }, data: { lastPostedAt: new Date() } });
  }
}

setInterval(() => { checkBusyReminders().catch((err) => console.error('checkBusyReminders failed:', err)); }, BUSY_REMINDER_CHECK_INTERVAL_MS);
setInterval(() => { checkUnclaimedMentorSearchRequests().catch((err) => console.error('checkUnclaimedMentorSearchRequests failed:', err)); }, STALE_SEARCH_REQUEST_CHECK_INTERVAL_MS);
// Also run shortly after startup, in case reminders were due while the bot was down.
setTimeout(() => { checkBusyReminders().catch((err) => console.error('checkBusyReminders failed:', err)); }, 30_000);
setTimeout(() => { checkUnclaimedMentorSearchRequests().catch((err) => console.error('checkUnclaimedMentorSearchRequests failed:', err)); }, 30_000);

app.listen(port, () => console.log(`Server listening on port ${port}`));
