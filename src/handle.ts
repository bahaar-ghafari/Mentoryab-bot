export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function format(text: string, values: Record<string, string | number> = {}) {
  return text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

// How people can reach a user on Telegram, as HTML: a tappable @username when
// they have one, otherwise a tg://user?id=… profile link. Only for messages
// sent with parse_mode HTML — build them with formatHtml().
export function userHandle(user: { username?: string | null; telegramId: string }, name?: string): string {
  if (user.username) return escapeHtml(`@${user.username}`);
  return `<a href="tg://user?id=${user.telegramId}">${escapeHtml(name || `ID ${user.telegramId}`)}</a>`;
}

// Like format(), but for parse_mode HTML: escapes the template and every value
// except the ones holding pre-built userHandle() markup (keys ending in "handle").
export function formatHtml(template: string, vars: Record<string, string | number>): string {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    safe[key] = /handle$/i.test(key) ? String(value) : escapeHtml(String(value));
  }
  return format(escapeHtml(template), safe);
}

export const HTML_OPTS = { parse_mode: 'HTML' as const, disable_web_page_preview: true };
