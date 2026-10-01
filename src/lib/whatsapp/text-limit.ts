/**
 * Upper bound for the body of a WhatsApp text message (S-L1, p11.4).
 *
 * Meta rejects the whole send above it, so an over-long AI reply used to
 * be lost entirely. See also `HANDOFF_MESSAGE_MAX_LEN` in
 * `src/app/api/ai/config/route.ts` ("WhatsApp allows 4096").
 *
 * Measured in UTF-16 code units (`String#length`), which are never fewer
 * than the characters Meta counts: the cut is conservative.
 */
export const WHATSAPP_TEXT_MAX_LENGTH = 4096;

const ELLIPSIS = '…';
/** How far back from the hard cut we look for a whitespace to cut at. */
const WORD_BOUNDARY_WINDOW = 200;

export interface FittedText {
  /** What to send: the input (trailing whitespace trimmed) or its truncation. */
  text: string;
  truncated: boolean;
  /** Length of the trimmed input, in UTF-16 code units. */
  originalLength: number;
}

/**
 * Fit a text into ONE WhatsApp message. Never splits: a reply is one
 * outbound message (Meta bills per delivered message, p11.4).
 *
 * Over the limit the text is cut to at most `max` units ending in «…»,
 * at the last whitespace of the final 200 characters when there is one,
 * and never in the middle of a surrogate pair.
 */
export function fitWhatsAppText(
  raw: string,
  max: number = WHATSAPP_TEXT_MAX_LENGTH
): FittedText {
  const text = raw.trimEnd();
  const originalLength = text.length;
  if (originalLength <= max) {
    return { text, truncated: false, originalLength };
  }

  let cut = max - ELLIPSIS.length;
  // Do not leave a lone high surrogate at the end (half an emoji).
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;

  const floor = Math.max(0, cut - WORD_BOUNDARY_WINDOW);
  for (let i = cut - 1; i >= floor; i--) {
    if (/\s/.test(text[i])) {
      cut = i;
      break;
    }
  }

  return {
    text: text.slice(0, cut).trimEnd() + ELLIPSIS,
    truncated: true,
    originalLength,
  };
}
