export type ContactType = 'telegram' | 'phone' | 'email';

export const CONTACT_LABELS: Record<ContactType, string> = {
  telegram: 'Telegram ID',
  phone: 'Phone Number',
  email: 'Email',
};

export function buildContactTypeKeyboard(collected: Partial<Record<ContactType, string>>, canGoBack: boolean) {
  const all: ContactType[] = ['telegram', 'phone', 'email'];
  const available = all.filter((t) => !collected[t]);
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  for (let i = 0; i < available.length; i += 2) {
    rows.push(
      available.slice(i, i + 2).map((t) => ({ text: CONTACT_LABELS[t], callback_data: `contact_type:${t}` }))
    );
  }

  const navRow: Array<{ text: string; callback_data: string }> = [];
  if (canGoBack) navRow.push({ text: '← Back', callback_data: 'back' });
  const count = Object.keys(collected).length;
  if (count > 0) navRow.push({ text: `Done ✅ (${count})`, callback_data: 'contact_done' });
  if (navRow.length > 0) rows.push(navRow);

  return { inline_keyboard: rows };
}

export function renderContactMethodsSummary(contactMethods?: Partial<Record<ContactType, string>>) {
  if (!contactMethods || Object.keys(contactMethods).length === 0) return null;
  return (Object.entries(contactMethods) as Array<[ContactType, string]>)
    .map(([type, value]) => `${CONTACT_LABELS[type]}: ${value}`)
    .join(', ');
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}
