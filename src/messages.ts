// Telegram rejects messages over 4096 characters. Split on paragraph (blank
// line) boundaries so list entries are never cut in half.
export const TELEGRAM_MAX_LENGTH = 4000;

export function splitForTelegram(header: string, entries: string[], limit = TELEGRAM_MAX_LENGTH): string[] {
  const chunks: string[] = [];
  let current = header;
  for (const entry of entries) {
    // A single oversized entry is hard-cut so it can never exceed the limit.
    const parts = entry.length > limit ? entry.match(new RegExp(`[\\s\\S]{1,${limit}}`, 'g')) ?? [] : [entry];
    for (const part of parts) {
      const candidate = current ? `${current}\n\n${part}` : part;
      if (candidate.length > limit && current) {
        chunks.push(current);
        current = part;
      } else {
        current = candidate;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
