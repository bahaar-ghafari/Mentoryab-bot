export type ContactType = 'telegram' | 'phone' | 'email';

export const CONTACT_LABELS: Record<ContactType, string> = {
  telegram: '💬 Telegram ID',
  phone: '📱 Phone Number',
  email: '📧 Email',
};

export function buildContactTypeKeyboard(
  collected: Partial<Record<ContactType, string>>,
  canGoBack: boolean,
  labels: Record<ContactType, string> = CONTACT_LABELS,
  ui: { back: string; done: string } = { back: '← Back', done: 'Done' }
) {
  // Always show every type, not just missing ones — otherwise there's no way
  // to change a contact method once it's set (all three would be "collected"
  // when editing an existing profile, leaving nothing to tap).
  const all: ContactType[] = ['telegram', 'phone', 'email'];
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  for (let i = 0; i < all.length; i += 2) {
    rows.push(
      all.slice(i, i + 2).map((t) => ({ text: `${collected[t] ? '✅ ' : ''}${labels[t]}`, callback_data: `contact_type:${t}` }))
    );
  }

  const navRow: Array<{ text: string; callback_data: string }> = [];
  if (canGoBack) navRow.push({ text: ui.back, callback_data: 'back' });
  const count = Object.keys(collected).length;
  if (count > 0) navRow.push({ text: `${ui.done} ✅ (${count})`, callback_data: 'contact_done' });
  if (navRow.length > 0) rows.push(navRow);

  return { inline_keyboard: rows };
}

export function renderContactMethodsSummary(
  contactMethods?: Partial<Record<ContactType, string>>,
  labels: Record<ContactType, string> = CONTACT_LABELS
) {
  if (!contactMethods || Object.keys(contactMethods).length === 0) return null;
  return (Object.entries(contactMethods) as Array<[ContactType, string]>)
    .map(([type, value]) => `${labels[type]}: ${value}`)
    .join(', ');
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}
