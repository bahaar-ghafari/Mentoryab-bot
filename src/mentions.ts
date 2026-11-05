// Telegram caps a message at 4096 characters. Mentioning every non-mentor in one
// message overflows that once the group is big, so pack mentions into batches.
const MAX_MESSAGE_LENGTH = 4000;

/**
 * Splits mention strings into messages. The first message also carries `body`
 * (so its mention budget is smaller); later messages contain mentions only.
 * Returned strings are space-joined mentions; the caller appends `body`.
 */
export function chunkMentions(mentions: string[], bodyLength: number, maxLength = MAX_MESSAGE_LENGTH): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  let budget = Math.max(maxLength - bodyLength - 2, 200);

  for (const mention of mentions) {
    const add = mention.length + (current.length ? 1 : 0);
    if (current.length && length + add > budget) {
      chunks.push(current);
      current = [];
      length = 0;
      budget = maxLength;
    }
    length += mention.length + (current.length ? 1 : 0);
    current.push(mention);
  }
  if (current.length) chunks.push(current);
  return chunks;
}
