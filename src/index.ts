import dotenv from 'dotenv';
import express from 'express';
import TelegramBot, { type Message } from 'node-telegram-bot-api';
import { PrismaClient, Prisma } from '@prisma/client';
import { findMentorMatches, canonicalizeSkill } from './matching.js';
import { getTexts, LOCALE_TEXTS, LANGUAGE_CHOICES, isLocale, type Locale, type Texts } from './i18n/index.js';
import { translateOption, getContactLabels } from './i18n/labels.js';
import { SKILL_OPTIONS } from './i18n/options.js';
import { matchesMenuButton } from './i18n/menuButtons.js';
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
  // Set when this state exists to edit a single field of an existing profile
  // (via the profile view's per-field edit buttons) rather than run full
  // onboarding — capturing that field's new value saves just that field and
  // returns to the profile view, instead of advancing to the next question.
  editingField?: string;
  // Set when an admin is editing someone else's profile from the admin list —
  // the field's new value is saved to this telegramId's profile instead of
  // the acting (admin) telegramId's own, and the audit actor is 'admin'.
  targetTelegramId?: string;
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

// Set Busy/Available now lives inside the profile view (alongside Edit and
// Delete) rather than as its own persistent reply-keyboard button.
function buildMainMenuKeyboard(hasProfile: boolean, isAdmin: boolean, t: Texts) {
  const keyboard: Array<Array<{ text: string }>> = [];
  keyboard.push([{ text: t.startMenu.joinMentors }, { text: t.startMenu.needMentor }]);
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
      text = state.editingField ? t.prompts.editName : (role === 'mentor' ? t.mentorStart : t.menteeStart);
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

  if (!state.editingField) {
    const totalSteps = ONBOARDING_STEPS[role].length;
    text = `${format(t.ui.stepIndicator, { current: state.stepIndex + 1, total: totalSteps })}\n${text}`;
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
  // The keyboard rides along on this welcome message instead of a separate
  // "Choose an option:" message.
  if (isMentorNow && !hadProfileBefore) {
    await bot.sendMessage(chatId, t.messages.mentorWelcome, {
      reply_markup: buildMainMenuKeyboard(true, adminIds.has(telegramId), t),
    });
  } else {
    await bot.sendMessage(chatId, t.chooseRole, {
      reply_markup: buildMainMenuKeyboard(true, adminIds.has(telegramId), t),
    });
  }

  // A mentee finishing onboarding almost certainly wants to see matches right
  // away rather than tapping Find Mentor again immediately afterward.
  if (!isMentorNow) {
    await searchMentorsForMentee(chatId, telegramId);
  }
}

// ── Profile view (Edit Profile) ───────────────────────────────────────────────

const MENTOR_PROFILE_FIELDS = ['name', 'title', 'skills', 'experience', 'country', 'city', 'contact', 'language'] as const;
const MENTEE_PROFILE_FIELDS = ['name', 'goals', 'skills', 'experience', 'country', 'city', 'language'] as const;

function buildFieldEditKeyboard(
  role: 'mentor' | 'mentee',
  t: Texts,
  fieldCallback: (field: string) => string,
  deleteCallback: string | null,
  extraRows: Array<Array<{ text: string; callback_data: string }>> = []
) {
  const fields = role === 'mentor' ? MENTOR_PROFILE_FIELDS : MENTEE_PROFILE_FIELDS;
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < fields.length; i += 2) {
    rows.push(
      fields.slice(i, i + 2).map((f) => ({ text: t.summary[f as keyof Texts['summary']], callback_data: fieldCallback(f) }))
    );
  }
  if (deleteCallback) {
    rows.push([{ text: t.messages.deleteProfileButton, callback_data: deleteCallback }]);
  }
  rows.push(...extraRows);
  return { inline_keyboard: rows };
}

// Top-level profile actions: Edit (drills into the field list below), Set
// Busy/Available (mentor only — shows whichever action currently applies),
// and Delete — siblings, rather than mixing the busy toggle into the main
// reply keyboard or the field-by-field editor.
function buildProfileActionsKeyboard(role: 'mentor' | 'mentee', isAvailable: boolean, t: Texts) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [
    [{ text: t.messages.editProfileMenuButton, callback_data: 'profile_edit_menu' }],
  ];
  if (role === 'mentor') {
    rows.push([{
      text: isAvailable ? t.startMenu.busy : t.startMenu.available,
      callback_data: isAvailable ? 'profile_set_busy' : 'profile_set_available',
    }]);
  }
  rows.push([{ text: t.messages.deleteProfileButton, callback_data: 'delete_profile_confirm' }]);
  return { inline_keyboard: rows };
}

function buildProfileFieldListKeyboard(role: 'mentor' | 'mentee', t: Texts) {
  return buildFieldEditKeyboard(role, t, (f) => `edit_field:${f}`, null, [[{ text: t.ui.back, callback_data: 'profile_actions_back' }]]);
}

async function showProfileView(chatId: number, telegramId: string) {
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true, menteeProfile: true } });
  const t = getTexts(user?.language);
  if (!user) return;

  const role: 'mentor' | 'mentee' | null = user.mentorProfile ? 'mentor' : user.menteeProfile ? 'mentee' : null;
  if (!role) { await bot.sendMessage(chatId, t.messages.noProfileYet); return; }

  const mentor = user.mentorProfile;
  const mentee = user.menteeProfile;
  const profile = (mentor ?? mentee)!;
  const skills = mentor ? mentor.skills : mentee!.skillsNeeded;
  const displaySkills = skills.map((s) => translateOption(t.locale, s, 'skill')).join(', ') || t.messages.notAvailable;
  const displayTitle = mentor?.title ? translateOption(t.locale, mentor.title, 'title') : null;
  const displayCountry = profile.country ? translateOption(t.locale, profile.country, 'country') : null;

  const lines = [
    `${t.summary.name}: ${profile.name}`,
    displayTitle ? `${t.summary.title}: ${displayTitle}` : null,
    `${t.summary.skills}: ${displaySkills}`,
    `${t.summary.experience}: ${format(t.summary.yearsLabel, { n: profile.experienceYears ?? 0 })}`,
    displayCountry ? `${t.summary.country}: ${displayCountry}` : null,
    profile.city ? `${t.summary.city}: ${profile.city}` : null,
    `${t.summary.language}: ${languageDisplayName(profile.language)}`,
    mentor && mentor.contactMethods.length ? `${t.summary.contact}: ${mentor.contactMethods.join(', ')}` : null,
    mentee?.goals ? `${t.summary.goals}: ${mentee.goals}` : null,
  ].filter(Boolean).join('\n');

  await bot.sendMessage(chatId, `${t.messages.profileViewHeader}\n\n${lines}`, {
    reply_markup: buildProfileActionsKeyboard(role, mentor?.availability ?? true, t),
  });
}

// Admin equivalent of showProfileView, for an arbitrary mentor/mentee by ID
// rather than the acting user's own profile — reachable from the admin
// mentors/mentees list so an admin can edit or delete anyone's profile.
async function renderAdminProfileManageView(chatId: number, telegramId: string, role: 'mentor' | 'mentee', profileId: number) {
  const admin = await prisma.user.findUnique({ where: { telegramId } });
  const t = getTexts(admin?.language);

  let name: string;
  let experienceYears: number | null;
  let country: string | null;
  let city: string | null;
  let language: string;
  let skills: string[];
  let displayTitle: string | null = null;
  let contactSummary: string | null = null;
  let goals: string | null = null;

  if (role === 'mentor') {
    const profile = await prisma.mentorProfile.findUnique({ where: { id: profileId } });
    if (!profile) { await bot.sendMessage(chatId, t.admin.profileNotFound); return; }
    ({ name, experienceYears, country, city, language } = profile);
    skills = profile.skills;
    displayTitle = profile.title ? translateOption(t.locale, profile.title, 'title') : null;
    contactSummary = profile.contactMethods.length ? profile.contactMethods.join(', ') : null;
  } else {
    const profile = await prisma.menteeProfile.findUnique({ where: { id: profileId } });
    if (!profile) { await bot.sendMessage(chatId, t.admin.profileNotFound); return; }
    ({ name, experienceYears, country, city, language } = profile);
    skills = profile.skillsNeeded;
    goals = profile.goals;
  }

  const displaySkills = skills.map((s) => translateOption(t.locale, s, 'skill')).join(', ') || t.messages.notAvailable;
  const displayCountry = country ? translateOption(t.locale, country, 'country') : null;

  const lines = [
    `${t.summary.name}: ${name}`,
    displayTitle ? `${t.summary.title}: ${displayTitle}` : null,
    `${t.summary.skills}: ${displaySkills}`,
    `${t.summary.experience}: ${format(t.summary.yearsLabel, { n: experienceYears ?? 0 })}`,
    displayCountry ? `${t.summary.country}: ${displayCountry}` : null,
    city ? `${t.summary.city}: ${city}` : null,
    `${t.summary.language}: ${languageDisplayName(language)}`,
    contactSummary ? `${t.summary.contact}: ${contactSummary}` : null,
    goals ? `${t.summary.goals}: ${goals}` : null,
  ].filter(Boolean).join('\n');

  const keyboard = buildFieldEditKeyboard(
    role, t,
    (f) => `admin_edit_field:${role}:${profileId}:${f}`,
    `admin_delete_profile_confirm:${role}:${profileId}`,
    [[{ text: t.browse.backToList, callback_data: `admin_back_to_list:${role}` }]]
  );

  await bot.sendMessage(chatId, `${t.messages.profileViewHeader}\n\n${lines}`, { reply_markup: keyboard });
}

// Advances to the next onboarding step as usual, unless this state exists to
// edit a single field of an existing profile — then it saves just that field
// and returns to the profile view instead of continuing through every question.
async function advanceOrFinish(chatId: number, telegramId: string, state: UserState) {
  if (state.editingField) {
    await saveEditedFieldAndReturnToProfile(chatId, telegramId, state);
    return;
  }
  state.stepIndex += 1;
  const nextStep = ONBOARDING_STEPS[state.role][state.stepIndex] as string | undefined;
  if (!nextStep) { await finishOnboarding(chatId, telegramId, state); return; }
  await showStep(chatId, nextStep, state.role, telegramId);
}

async function saveEditedFieldAndReturnToProfile(chatId: number, telegramId: string, state: UserState) {
  const field = state.editingField!;
  const targetTelegramId = state.targetTelegramId ?? telegramId;
  const user = await prisma.user.findUnique({ where: { telegramId: targetTelegramId }, include: { mentorProfile: true, menteeProfile: true } });
  const profileId = state.role === 'mentor' ? user?.mentorProfile?.id : user?.menteeProfile?.id;

  if (profileId) {
    let updateData: Record<string, unknown> = {};

    if (field === 'name') {
      updateData.name = state.profile.name;
    } else if (field === 'title' && state.role === 'mentor') {
      updateData.title = state.profile.title || null;
    } else if (field === 'goals' && state.role === 'mentee') {
      updateData.goals = state.profile.goals || null;
    } else if (field === 'language') {
      // The profile's spoken language, used for matching/filters — distinct
      // from the UI text locale (state.language), which is untouched here.
      updateData.language = state.profile.language;
    } else if (field === 'skills') {
      const skillsArr = (state.profile.skills || '').split(',').map((s) => s.trim()).filter(Boolean);
      updateData = state.role === 'mentor' ? { skills: skillsArr } : { skillsNeeded: skillsArr };
    } else if (field === 'experience') {
      updateData.experienceYears = state.profile.experience ? calcExperienceYears(state.profile.experience) : 0;
    } else if (field === 'country' || field === 'city') {
      const location = state.profile.city && state.profile.country
        ? `${state.profile.city}, ${state.profile.country}`
        : state.profile.country || state.profile.city || null;
      updateData = { [field]: state.profile[field] || null, location };
    } else if (field === 'contact' && state.role === 'mentor') {
      const contactMethods = state.contactMethods
        ? (Object.entries(state.contactMethods) as Array<[ContactType, string]>).map(([type, value]) => `${CONTACT_LABELS[type]}: ${value}`)
        : [];
      updateData = {
        contactMethods,
        telegramContact: state.contactMethods?.telegram || null,
        phoneContact: state.contactMethods?.phone || null,
        emailContact: state.contactMethods?.email || null,
      };
    }

    if (Object.keys(updateData).length > 0) {
      try {
        if (state.role === 'mentor') {
          await prisma.mentorProfile.update({ where: { id: profileId }, data: updateData });
        } else {
          await prisma.menteeProfile.update({ where: { id: profileId }, data: updateData });
        }
        await logProfileAudit(targetTelegramId, state.role === 'mentor' ? 'MENTOR' : 'MENTEE', 'UPDATE', state.targetTelegramId ? 'admin' : telegramId, { field, ...updateData });
      } catch (err: unknown) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const t = getTexts(state.language);
          await bot.sendMessage(chatId, t.messages.contactAlreadyTaken);
          userStates.delete(telegramId);
          return;
        }
        throw err;
      }
    }
  }

  userStates.delete(telegramId);
  if (state.targetTelegramId && profileId) {
    await renderAdminProfileManageView(chatId, telegramId, state.role, profileId);
  } else if (!state.targetTelegramId) {
    await showProfileView(chatId, telegramId);
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
    reply_markup: buildMainMenuKeyboard(Boolean(user?.mentorProfile || user?.menteeProfile), adminIds.has(telegramId), t),
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

// ── Menu action handlers ──────────────────────────────────────────────────────

const MIN_EXPLANATION_LENGTH = 50;
const MAX_EXPLANATION_LENGTH = 500;
// telegramIds currently being asked to explain what kind of mentor they need,
// after an automatic search found nobody with a relevant skill/title.
const pendingMentorExplanation = new Set<string>();

type BrowseFilterDimension = 'language' | 'title' | 'country';

interface MentorBrowseState {
  language?: string;
  title?: string;
  country?: string;
  page: number;
  messageId?: number;
  // Which sub-screen is currently shown in the same (edited-in-place) message.
  view: 'list' | 'filterMenu' | 'filterValues';
  filterDimension?: BrowseFilterDimension;
}
const mentorBrowseState = new Map<string, MentorBrowseState>();
const MENTORS_PER_PAGE = 5;

function getBrowseState(telegramId: string): MentorBrowseState {
  let state = mentorBrowseState.get(telegramId);
  if (!state) {
    state = { page: 0, view: 'list' };
    mentorBrowseState.set(telegramId, state);
  }
  return state;
}

async function sendBrowseView(chatId: number, telegramId: string, text: string, reply_markup: TelegramBot.InlineKeyboardMarkup) {
  const browseState = getBrowseState(telegramId);
  if (browseState.messageId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: browseState.messageId, reply_markup });
      return;
    } catch { /* message may be gone — fall through and send a fresh one */ }
  }
  const sent = await bot.sendMessage(chatId, text, { reply_markup });
  browseState.messageId = (sent as Message).message_id;
}

function buildActiveFiltersSummary(browseState: MentorBrowseState, t: Texts): { labels: string[]; text: string } {
  const labels: string[] = [];
  if (browseState.language) labels.push(`🌐 ${languageDisplayName(browseState.language)}`);
  if (browseState.title) labels.push(`💼 ${translateOption(t.locale, browseState.title, 'title')}`);
  if (browseState.country) labels.push(translateOption(t.locale, browseState.country, 'country'));
  const text = labels.length ? format(t.browse.activeFilters, { filters: labels.join(', ') }) : t.browse.noFiltersApplied;
  return { labels, text };
}

// Compact results view: just the matching mentors + pagination + a single
// "Filters" button (showing how many are active) instead of every filter
// option inline — keeps the keyboard short regardless of how many distinct
// languages/titles/countries exist among available mentors.
async function renderMentorBrowseList(chatId: number, telegramId: string) {
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { menteeProfile: true } });
  const t = getTexts(user?.language);
  if (!user?.menteeProfile) { await bot.sendMessage(chatId, t.messages.completeMenteeProfile); return; }

  const allMentors = await prisma.mentorProfile.findMany({ where: { availability: true } });

  if (!allMentors.length) {
    pendingMentorExplanation.add(telegramId);
    await bot.sendMessage(chatId, t.browse.noneAvailable);
    await bot.sendMessage(chatId, format(t.messages.askMentorExplanation, { min: MIN_EXPLANATION_LENGTH, max: MAX_EXPLANATION_LENGTH }));
    return;
  }

  const browseState = getBrowseState(telegramId);
  browseState.view = 'list';

  const ranked = findMentorMatches(
    { name: user.menteeProfile.name, skillsNeeded: user.menteeProfile.skillsNeeded, experienceYears: user.menteeProfile.experienceYears, location: user.menteeProfile.location, language: user.menteeProfile.language },
    allMentors.map((m) => ({ id: m.id, name: m.name, title: m.title, skills: m.skills, experienceYears: m.experienceYears, location: m.location, availability: m.availability, language: m.language }))
  );

  const countryById = new Map(allMentors.map((m) => [m.id, m.country]));
  const filtered = ranked.filter((m) => {
    if (browseState.language && m.language !== browseState.language) return false;
    if (browseState.title && m.title !== browseState.title) return false;
    if (browseState.country && countryById.get(m.id) !== browseState.country) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / MENTORS_PER_PAGE));
  browseState.page = Math.min(Math.max(0, browseState.page), totalPages - 1);
  const pageItems = filtered.slice(browseState.page * MENTORS_PER_PAGE, browseState.page * MENTORS_PER_PAGE + MENTORS_PER_PAGE);

  const { labels: activeFilterLabels, text: filtersSummary } = buildActiveFiltersSummary(browseState, t);

  let text = `${t.browse.header}\n\n${filtersSummary}\n`;
  if (!filtered.length) {
    text += `\n${t.browse.noneMatchFilters}`;
  } else {
    pageItems.forEach((m, idx) => {
      const num = browseState.page * MENTORS_PER_PAGE + idx + 1;
      const displaySkills = m.skills.map((s) => translateOption(t.locale, s, 'skill')).join(', ') || t.messages.notAvailable;
      const displayTitle = m.title ? translateOption(t.locale, m.title, 'title') : null;
      text += `\n${num}. 👤 ${m.name}`;
      if (displayTitle) text += `\n${t.summary.title}: ${displayTitle}`;
      text += `\n${t.summary.skills}: ${displaySkills}`;
      text += `\n${t.summary.experience}: ${format(t.summary.yearsLabel, { n: m.experienceYears })}`;
      text += `\n${t.summary.location}: ${m.location || t.messages.notAvailable}`;
      text += `\n${t.summary.language}: ${languageDisplayName(m.language)}\n`;
    });
    text += `\n${format(t.browse.pageIndicator, { current: browseState.page + 1, total: totalPages })}`;
  }

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  pageItems.forEach((m, idx) => {
    const num = browseState.page * MENTORS_PER_PAGE + idx + 1;
    keyboard.push([{ text: `${num}. ${t.messages.requestButtonPrefix} ${m.name}`, callback_data: `request:${m.id}` }]);
  });

  const navRow: Array<{ text: string; callback_data: string }> = [];
  if (browseState.page > 0) navRow.push({ text: t.browse.prevPage, callback_data: 'browse_page:prev' });
  if (browseState.page < totalPages - 1) navRow.push({ text: t.browse.nextPage, callback_data: 'browse_page:next' });
  if (navRow.length) keyboard.push(navRow);

  keyboard.push([{
    text: activeFilterLabels.length ? format(t.browse.filtersButtonActive, { count: activeFilterLabels.length }) : t.browse.filtersButton,
    callback_data: 'browse_open_filters',
  }]);
  keyboard.push([{ text: t.browse.cantFindButton, callback_data: 'browse_explain' }]);

  await sendBrowseView(chatId, telegramId, text, { inline_keyboard: keyboard });
}

// Compact category chooser — tapping a dimension drills into its values.
async function renderFilterMenu(chatId: number, telegramId: string) {
  const user = await prisma.user.findUnique({ where: { telegramId } });
  const t = getTexts(user?.language);
  const browseState = getBrowseState(telegramId);
  browseState.view = 'filterMenu';

  const { labels: activeFilterLabels, text: filtersSummary } = buildActiveFiltersSummary(browseState, t);
  const text = `${t.browse.filterMenuHeader}\n\n${filtersSummary}`;

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [
    [{ text: `${browseState.language ? '✅ ' : ''}${t.browse.filterLanguageOption}`, callback_data: 'browse_filter_dim:language' }],
    [{ text: `${browseState.title ? '✅ ' : ''}${t.browse.filterTitleOption}`, callback_data: 'browse_filter_dim:title' }],
    [{ text: `${browseState.country ? '✅ ' : ''}${t.browse.filterCountryOption}`, callback_data: 'browse_filter_dim:country' }],
  ];
  if (activeFilterLabels.length) {
    keyboard.push([{ text: t.browse.clearFilters, callback_data: 'browse_clear' }]);
  }
  keyboard.push([{ text: t.browse.backToList, callback_data: 'browse_back_to_list' }]);

  await sendBrowseView(chatId, telegramId, text, { inline_keyboard: keyboard });
}

// Values for one filter dimension — built from whatever actually exists
// among currently available mentors.
async function renderFilterValues(chatId: number, telegramId: string, dimension: BrowseFilterDimension) {
  const user = await prisma.user.findUnique({ where: { telegramId } });
  const t = getTexts(user?.language);
  const browseState = getBrowseState(telegramId);
  browseState.view = 'filterValues';
  browseState.filterDimension = dimension;

  const allMentors = await prisma.mentorProfile.findMany({ where: { availability: true } });

  let values: string[];
  let translateValue: (v: string) => string;
  if (dimension === 'language') {
    values = [...new Set(allMentors.map((m) => m.language))];
    translateValue = languageDisplayName;
  } else if (dimension === 'title') {
    values = [...new Set(allMentors.map((m) => m.title).filter((v): v is string => !!v))];
    translateValue = (v) => translateOption(t.locale, v, 'title');
  } else {
    values = [...new Set(allMentors.map((m) => m.country).filter((v): v is string => !!v))];
    translateValue = (v) => translateOption(t.locale, v, 'country');
  }

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < values.length; i += 2) {
    keyboard.push(values.slice(i, i + 2).map((v) => ({
      text: `${browseState[dimension] === v ? '✅ ' : ''}${translateValue(v)}`,
      callback_data: `browse_filter:${dimension}:${v}`,
    })));
  }
  keyboard.push([{ text: t.browse.backToFilterMenu, callback_data: 'browse_open_filters' }]);

  await sendBrowseView(chatId, telegramId, t.browse.filterValuesHeader, { inline_keyboard: keyboard });
}

async function searchMentorsForMentee(chatId: number, telegramId: string) {
  // Fresh search — reset any filters/page left over from a previous session.
  mentorBrowseState.delete(telegramId);
  await renderMentorBrowseList(chatId, telegramId);
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


const handleHelp = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  const user = await prisma.user.findUnique({ where: { telegramId } });
  const t = getTexts(user?.language);
  await bot.sendMessage(msg.chat.id, t.messages.helpText);
};

// Re-runs the same onboarding flow the user already completed — finishOnboarding
// now upserts the existing profile rather than crashing, so this doubles as "edit".
const handleEditProfile = async (msg: Message) => {
  await showProfileView(msg.chat.id, String(msg.from?.id));
};

async function renderAdminMentorsList(chatId: number, telegramId: string) {
  const admin = await prisma.user.findUnique({ where: { telegramId } });
  const t = getTexts(admin?.language);
  const mentors = await prisma.mentorProfile.findMany({ orderBy: { createdAt: 'asc' } });
  if (!mentors.length) { await bot.sendMessage(chatId, t.admin.noMentorsRegistered); return; }
  const lines = mentors.map((m, i) => [
    `${i + 1}. ${m.name} [${m.availability ? t.admin.available : t.admin.busy}]`,
    m.title ? `   ${t.summary.title}: ${translateOption(t.locale, m.title, 'title')}` : null,
    `   ${t.summary.skills}: ${m.skills.map((s) => translateOption(t.locale, s, 'skill')).join(', ')}`,
    `   ${t.summary.experience}: ${format(t.summary.yearsLabel, { n: m.experienceYears })}`,
    m.location ? `   ${t.summary.location}: ${m.location}` : null,
    `   ${t.summary.language}: ${languageDisplayName(m.language)}`,
    m.contactMethods.length ? `   ${t.summary.contact}: ${m.contactMethods.join(', ')}` : null,
  ].filter(Boolean).join('\n'));
  await bot.sendMessage(chatId, `${format(t.admin.mentorsListHeader, { count: mentors.length })}\n\n${lines.join('\n\n')}`);

  const manageRows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < mentors.length; i += 2) {
    manageRows.push(
      mentors.slice(i, i + 2).map((m, idx) => ({ text: `${i + idx + 1}. ${m.name}`, callback_data: `admin_manage_mentor:${m.id}` }))
    );
  }
  await bot.sendMessage(chatId, t.admin.manageMentorsPrompt, { reply_markup: { inline_keyboard: manageRows } });
}

async function renderAdminMenteesList(chatId: number, telegramId: string) {
  const admin = await prisma.user.findUnique({ where: { telegramId } });
  const t = getTexts(admin?.language);
  const mentees = await prisma.menteeProfile.findMany({ orderBy: { createdAt: 'asc' } });
  if (!mentees.length) { await bot.sendMessage(chatId, t.admin.noMenteesRegistered); return; }
  const lines = mentees.map((m, i) => [
    `${i + 1}. ${m.name}`,
    `   ${t.summary.skills}: ${m.skillsNeeded.map((s) => translateOption(t.locale, s, 'skill')).join(', ')}`,
    m.experienceYears != null ? `   ${t.summary.experience}: ${format(t.summary.yearsLabel, { n: m.experienceYears })}` : null,
    m.location ? `   ${t.summary.location}: ${m.location}` : null,
    `   ${t.summary.language}: ${languageDisplayName(m.language)}`,
    m.goals ? `   ${t.summary.goals}: ${m.goals}` : null,
  ].filter(Boolean).join('\n'));
  await bot.sendMessage(chatId, `${format(t.admin.menteesListHeader, { count: mentees.length })}\n\n${lines.join('\n\n')}`);

  const manageRows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < mentees.length; i += 2) {
    manageRows.push(
      mentees.slice(i, i + 2).map((m, idx) => ({ text: `${i + idx + 1}. ${m.name}`, callback_data: `admin_manage_mentee:${m.id}` }))
    );
  }
  await bot.sendMessage(chatId, t.admin.manageMenteesPrompt, { reply_markup: { inline_keyboard: manageRows } });
}

const handleAdminMentorsList = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  await renderAdminMentorsList(msg.chat.id, telegramId);
};

const handleAdminMenteesList = async (msg: Message) => {
  const telegramId = String(msg.from?.id);
  if (!adminIds.has(telegramId)) return;
  await renderAdminMenteesList(msg.chat.id, telegramId);
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

    // Editing the profile's spoken language (used for matching/filters) is
    // separate from the UI text locale — do NOT touch User.language or
    // state.language here; only /language (or the onboarding step) does that.
    if (state?.editingField === 'language') {
      state.profile.language = code;
      await saveEditedFieldAndReturnToProfile(chatId, telegramId, state);
      return;
    }

    await prisma.user.upsert({
      where: { telegramId },
      update: { language: code },
      create: { telegramId, language: code },
    });

    const isOnboardingLanguageStep = !!state && ONBOARDING_STEPS[state.role][state.stepIndex] === 'language';
    if (state && isOnboardingLanguageStep) {
      state.language = code;
      await advanceOrFinish(chatId, telegramId, state);
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
    const mentorUser = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true, menteeProfile: true } });
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
      await showProfileView(chatId, telegramId);
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
    await showProfileView(chatId, telegramId);
    return;
  }

  // ── Mentor browse: open filters, drill into a dimension, toggle a value,
  // clear filters, page, navigate back, or "can't find" ──
  if (data === 'browse_open_filters') {
    if (!chatId) return;
    await renderFilterMenu(chatId, telegramId);
    return;
  }

  if (data.startsWith('browse_filter_dim:')) {
    if (!chatId) return;
    const dimension = data.slice('browse_filter_dim:'.length) as BrowseFilterDimension;
    await renderFilterValues(chatId, telegramId, dimension);
    return;
  }

  if (data.startsWith('browse_filter:')) {
    if (!chatId) return;
    const rest = data.slice('browse_filter:'.length);
    const sepIdx = rest.indexOf(':');
    const dimension = rest.slice(0, sepIdx) as BrowseFilterDimension;
    const value = rest.slice(sepIdx + 1);
    const browseState = getBrowseState(telegramId);
    browseState[dimension] = browseState[dimension] === value ? undefined : value;
    browseState.page = 0;
    // Applying a value returns straight to the results so the effect is visible immediately.
    await renderMentorBrowseList(chatId, telegramId);
    return;
  }

  if (data === 'browse_clear') {
    if (!chatId) return;
    const browseState = getBrowseState(telegramId);
    browseState.language = undefined;
    browseState.title = undefined;
    browseState.country = undefined;
    browseState.page = 0;
    await renderMentorBrowseList(chatId, telegramId);
    return;
  }

  if (data === 'browse_back_to_list') {
    if (!chatId) return;
    await renderMentorBrowseList(chatId, telegramId);
    return;
  }

  if (data.startsWith('browse_page:')) {
    if (!chatId) return;
    const direction = data.slice('browse_page:'.length);
    const browseState = getBrowseState(telegramId);
    browseState.page += direction === 'next' ? 1 : -1;
    if (browseState.page < 0) browseState.page = 0;
    await renderMentorBrowseList(chatId, telegramId);
    return;
  }

  if (data === 'browse_explain') {
    if (!chatId) return;
    pendingMentorExplanation.add(telegramId);
    await bot.sendMessage(chatId, format(t.messages.askMentorExplanation, {
      min: MIN_EXPLANATION_LENGTH,
      max: MAX_EXPLANATION_LENGTH,
    }));
    return;
  }

  // ── Profile actions: drill into the field list, or back out of it ──
  if (data === 'profile_edit_menu') {
    if (!chatId) return;
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true, menteeProfile: true } });
    const role: 'mentor' | 'mentee' | null = user?.mentorProfile ? 'mentor' : user?.menteeProfile ? 'mentee' : null;
    if (!role) return;
    await bot.sendMessage(chatId, t.messages.profileEditMenuHeader, {
      reply_markup: buildProfileFieldListKeyboard(role, t),
    });
    return;
  }

  if (data === 'profile_actions_back') {
    if (!chatId) return;
    await showProfileView(chatId, telegramId);
    return;
  }

  // ── Profile actions: toggle busy/available (mentor only) ──
  if (data === 'profile_set_busy') {
    if (!chatId) return;
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true } });
    if (!user?.mentorProfile) return;
    await bot.sendMessage(chatId, t.busyFlow.prompt, { reply_markup: buildBusyDurationKeyboard(t) });
    return;
  }

  if (data === 'profile_set_available') {
    if (!chatId) return;
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true } });
    if (!user?.mentorProfile) return;
    await prisma.mentorProfile.update({ where: { id: user.mentorProfile.id }, data: { availability: true, busyUntil: null } });
    await bot.sendMessage(chatId, t.messages.availableSet);
    await showProfileView(chatId, telegramId);
    return;
  }

  // ── Edit a single field from the profile view ──
  if (data.startsWith('edit_field:')) {
    if (!chatId) return;
    const field = data.slice('edit_field:'.length);
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true, menteeProfile: true } });
    if (!user) return;
    const role: 'mentor' | 'mentee' | null = user.mentorProfile ? 'mentor' : user.menteeProfile ? 'mentee' : null;
    if (!role) return;

    const mentor = user.mentorProfile;
    const mentee = user.menteeProfile;
    const skills = mentor ? mentor.skills : mentee!.skillsNeeded;

    const editState: UserState = {
      role,
      stepIndex: 0,
      profile: {
        name: (mentor ?? mentee)!.name,
        title: mentor?.title || '',
        goals: mentee?.goals || '',
        skills: skills.join(', '),
        country: (mentor ?? mentee)!.country || '',
        city: (mentor ?? mentee)!.city || '',
      },
      selectedSkills: [...skills],
      language: isLocale(user.language) ? user.language : 'en',
      editingField: field,
    };
    if (mentor) {
      const existingContacts: Partial<Record<ContactType, string>> = {};
      if (mentor.telegramContact) existingContacts.telegram = mentor.telegramContact;
      if (mentor.phoneContact) existingContacts.phone = mentor.phoneContact;
      if (mentor.emailContact) existingContacts.email = mentor.emailContact;
      editState.contactMethods = existingContacts;
    }
    userStates.set(telegramId, editState);

    if (field === 'language') {
      const editT = getTexts(editState.language);
      await bot.sendMessage(chatId, editT.prompts.editSpokenLanguage, {
        reply_markup: buildLanguageInlineKeyboard(),
      });
      return;
    }
    await showStep(chatId, field, role, telegramId);
    return;
  }

  // ── Self-service profile delete: confirm, then delete (keeping an audit record) ──
  if (data === 'delete_profile_confirm') {
    if (!chatId) return;
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true, menteeProfile: true } });
    const role: 'mentor' | 'mentee' | null = user?.mentorProfile ? 'mentor' : user?.menteeProfile ? 'mentee' : null;
    if (!role) return;
    const roleLabel = role === 'mentor' ? t.summary.roleMentor : t.summary.roleMentee;
    await bot.sendMessage(chatId, format(t.messages.deleteProfileConfirm, { role: roleLabel }), {
      reply_markup: {
        inline_keyboard: [[
          { text: t.messages.deleteProfileConfirmYes, callback_data: 'delete_profile_yes' },
          { text: t.messages.deleteProfileConfirmCancel, callback_data: 'delete_profile_no' },
        ]],
      },
    });
    return;
  }

  if (data === 'delete_profile_yes') {
    if (!chatId) return;
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { mentorProfile: true, menteeProfile: true } });
    const role: 'mentor' | 'mentee' | null = user?.mentorProfile ? 'mentor' : user?.menteeProfile ? 'mentee' : null;
    if (!user || !role) return;
    const roleLabel = role === 'mentor' ? t.summary.roleMentor : t.summary.roleMentee;

    if (role === 'mentor' && user.mentorProfile) {
      await logProfileAudit(telegramId, 'MENTOR', 'DELETE', telegramId, user.mentorProfile);
      await prisma.mentorProfile.delete({ where: { id: user.mentorProfile.id } });
    } else if (role === 'mentee' && user.menteeProfile) {
      await logProfileAudit(telegramId, 'MENTEE', 'DELETE', telegramId, user.menteeProfile);
      await prisma.menteeProfile.delete({ where: { id: user.menteeProfile.id } });
    }

    // A warm goodbye instead of "Choose an option:" — the keyboard rides
    // along on this message rather than a separate one.
    const stillHasOtherProfile = role === 'mentor' ? Boolean(user.menteeProfile) : Boolean(user.mentorProfile);
    await bot.sendMessage(chatId, format(t.messages.profileDeletedThankYou, { role: roleLabel }), {
      reply_markup: buildMainMenuKeyboard(stillHasOtherProfile, adminIds.has(telegramId), t),
    });
    return;
  }

  if (data === 'delete_profile_no') {
    if (!chatId) return;
    await showProfileView(chatId, telegramId);
    return;
  }

  // ── Admin: manage (edit/delete) any mentor or mentee from the admin list ──
  if (data.startsWith('admin_manage_mentor:') || data.startsWith('admin_manage_mentee:')) {
    if (!chatId || !adminIds.has(telegramId)) return;
    const isMentorTarget = data.startsWith('admin_manage_mentor:');
    const id = Number(data.slice(isMentorTarget ? 'admin_manage_mentor:'.length : 'admin_manage_mentee:'.length));
    await renderAdminProfileManageView(chatId, telegramId, isMentorTarget ? 'mentor' : 'mentee', id);
    return;
  }

  if (data.startsWith('admin_back_to_list:')) {
    if (!chatId || !adminIds.has(telegramId)) return;
    const role = data.slice('admin_back_to_list:'.length);
    if (role === 'mentor') await renderAdminMentorsList(chatId, telegramId);
    else await renderAdminMenteesList(chatId, telegramId);
    return;
  }

  if (data.startsWith('admin_edit_field:')) {
    if (!chatId || !adminIds.has(telegramId)) return;
    const rest = data.slice('admin_edit_field:'.length);
    const [role, profileIdStr, field] = rest.split(':') as ['mentor' | 'mentee', string, string];
    const profileId = Number(profileIdStr);
    const admin = await prisma.user.findUnique({ where: { telegramId } });
    const adminLocale: Locale = admin && isLocale(admin.language) ? admin.language : 'en';

    let editState: UserState;
    if (role === 'mentor') {
      const profile = await prisma.mentorProfile.findUnique({ where: { id: profileId }, include: { user: true } });
      if (!profile) return;
      const existingContacts: Partial<Record<ContactType, string>> = {};
      if (profile.telegramContact) existingContacts.telegram = profile.telegramContact;
      if (profile.phoneContact) existingContacts.phone = profile.phoneContact;
      if (profile.emailContact) existingContacts.email = profile.emailContact;
      editState = {
        role: 'mentor',
        stepIndex: 0,
        profile: {
          name: profile.name,
          title: profile.title || '',
          goals: '',
          skills: profile.skills.join(', '),
          country: profile.country || '',
          city: profile.city || '',
        },
        selectedSkills: [...profile.skills],
        contactMethods: existingContacts,
        language: adminLocale,
        editingField: field,
        targetTelegramId: profile.user.telegramId,
      };
    } else {
      const profile = await prisma.menteeProfile.findUnique({ where: { id: profileId }, include: { user: true } });
      if (!profile) return;
      editState = {
        role: 'mentee',
        stepIndex: 0,
        profile: {
          name: profile.name,
          title: '',
          goals: profile.goals || '',
          skills: profile.skillsNeeded.join(', '),
          country: profile.country || '',
          city: profile.city || '',
        },
        selectedSkills: [...profile.skillsNeeded],
        language: adminLocale,
        editingField: field,
        targetTelegramId: profile.user.telegramId,
      };
    }
    userStates.set(telegramId, editState);

    if (field === 'language') {
      const editT = getTexts(editState.language);
      await bot.sendMessage(chatId, editT.prompts.editSpokenLanguage, {
        reply_markup: buildLanguageInlineKeyboard(),
      });
      return;
    }
    await showStep(chatId, field, role, telegramId);
    return;
  }

  if (data.startsWith('admin_delete_profile_confirm:')) {
    if (!chatId || !adminIds.has(telegramId)) return;
    const [role, idStr] = data.slice('admin_delete_profile_confirm:'.length).split(':') as ['mentor' | 'mentee', string];
    const id = Number(idStr);
    const admin = await prisma.user.findUnique({ where: { telegramId } });
    const at = getTexts(admin?.language);
    const name = role === 'mentor'
      ? (await prisma.mentorProfile.findUnique({ where: { id } }))?.name
      : (await prisma.menteeProfile.findUnique({ where: { id } }))?.name;
    if (!name) { await bot.sendMessage(chatId, at.admin.profileNotFound); return; }
    const roleLabel = role === 'mentor' ? at.summary.roleMentor : at.summary.roleMentee;
    await bot.sendMessage(chatId, format(at.admin.confirmDeleteProfile, { role: roleLabel, name }), {
      reply_markup: {
        inline_keyboard: [[
          { text: at.messages.deleteProfileConfirmYes, callback_data: `admin_delete_profile_yes:${role}:${id}` },
          { text: at.messages.deleteProfileConfirmCancel, callback_data: `admin_manage_${role}:${id}` },
        ]],
      },
    });
    return;
  }

  if (data.startsWith('admin_delete_profile_yes:')) {
    if (!chatId || !adminIds.has(telegramId)) return;
    const [role, idStr] = data.slice('admin_delete_profile_yes:'.length).split(':') as ['mentor' | 'mentee', string];
    const id = Number(idStr);
    const admin = await prisma.user.findUnique({ where: { telegramId } });
    const at = getTexts(admin?.language);

    if (role === 'mentor') {
      const profile = await prisma.mentorProfile.findUnique({ where: { id }, include: { user: true } });
      if (!profile) { await bot.sendMessage(chatId, at.admin.profileNotFound); return; }
      await logProfileAudit(profile.user.telegramId, 'MENTOR', 'DELETE', 'admin', profile);
      await prisma.mentorProfile.delete({ where: { id } });
      await bot.sendMessage(chatId, format(at.admin.mentorDeleted, { id }));
    } else {
      const profile = await prisma.menteeProfile.findUnique({ where: { id }, include: { user: true } });
      if (!profile) { await bot.sendMessage(chatId, at.admin.profileNotFound); return; }
      await logProfileAudit(profile.user.telegramId, 'MENTEE', 'DELETE', 'admin', profile);
      await prisma.menteeProfile.delete({ where: { id } });
      await bot.sendMessage(chatId, format(at.admin.menteeDeleted, { id }));
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
    await advanceOrFinish(chatId, telegramId, state);
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
    if (state.editingField) {
      // Clear rather than keep the pre-populated existing value — Skip means
      // "no value", same as during onboarding.
      delete state.profile[state.editingField];
    }
    await advanceOrFinish(chatId, telegramId, state);
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
    await advanceOrFinish(chatId, telegramId, state);
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
    // Brief confirmation in the message before transitioning
    try {
      await bot.editMessageText(`${t.summary.careerStart}: ${monthName} ${year}`, {
        chat_id: chatId,
        message_id: state.currentMessageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch { /* ignore */ }
    await advanceOrFinish(chatId, telegramId, state);
    return;
  }

  // ── Title selected ──
  if (data.startsWith('title:') && !data.startsWith('title_')) {
    if (!state || !chatId) return;
    state.profile.title = data.slice('title:'.length);
    await advanceOrFinish(chatId, telegramId, state);
    return;
  }

  // ── Country selected ──
  if (data.startsWith('country:')) {
    if (!state || !chatId) return;
    state.profile.country = data.slice('country:'.length);
    await advanceOrFinish(chatId, telegramId, state);
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

// Checked before anything else on every incoming text message: tapping any
// main-menu button always cancels whatever was in progress (onboarding, the
// busy-duration prompt, the mentor-search explanation) and starts fresh with
// the new command, rather than being swallowed as raw input for the old flow.
// Become Mentor / Find Mentor used to be separate bot.onText listeners that
// fired independently of (and could race with) this handler — consolidated
// here so there's exactly one place that decides what a button tap does.
const MENU_ACTIONS: Array<[keyof Texts['startMenu'], (msg: Message) => Promise<void>]> = [
  ['joinMentors', startMentorOnboarding],
  ['needMentor', startOrSearchMentee],
  ['editProfile', handleEditProfile],
  ['help', handleHelp],
  ['adminMentors', handleAdminMentorsList],
  ['adminMentees', handleAdminMenteesList],
  ['adminRestart', handleAdminRestart],
];

function findMenuAction(text: string): ((msg: Message) => Promise<void>) | null {
  for (const [key, handler] of MENU_ACTIONS) {
    if (matchesMenuButton(text, key)) return handler;
  }
  return null;
}

bot.on('message', async (msg: Message) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  const text = msg.text;
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id);

  const menuAction = findMenuAction(text);
  if (menuAction) {
    userStates.delete(telegramId);
    pendingMentorExplanation.delete(telegramId);
    await menuAction(msg);
    return;
  }

  if (pendingMentorExplanation.has(telegramId)) { await handleMentorExplanationText(msg); return; }

  const state = userStates.get(telegramId);
  if (!state) return;

  const t = getTexts(state.language);

  // Inline keyboard steps — reject freetext
  if (state.awaitingSubStep === 'year' || state.awaitingSubStep === 'month') {
    await bot.sendMessage(chatId, t.messages.useButtons);
    return;
  }

  // Normal text step — when editing a single existing field, that field IS
  // the current step regardless of stepIndex (which stays 0 for edits).
  const currentStep = (state.editingField ?? ONBOARDING_STEPS[state.role][state.stepIndex]) as OnboardingStep;

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
    if (await isContactValueTaken(state.awaitingContactType, text, state.targetTelegramId ?? telegramId)) {
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
  await advanceOrFinish(chatId, telegramId, state);
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
