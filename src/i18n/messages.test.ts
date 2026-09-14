import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Locale dictionaries are hand-maintained. English is the source of
// truth (src/i18n/request.ts falls back to en.json only when a whole
// locale file is missing — there is no per-key fallback), so a key
// that lands in en.json and not in a translation renders as a raw
// keypath for users on that locale. This guards the parity.

const MESSAGES_DIR = join(process.cwd(), 'messages');
const SOURCE_LOCALE = 'en';
const TRANSLATED_LOCALES = ['es', 'ko'];
/** The locale a deployment gets when NEXT_PUBLIC_APP_LOCALE is unset. */
const DEFAULT_LOCALE = 'es';

/**
 * Keys whose Spanish value is allowed to read exactly like the English
 * one. Every entry is a brand, an acronym, a sample value or a word
 * Spanish spells the same way — never a sentence someone forgot to
 * translate. Anything not on this list and identical to `en` fails the
 * "nothing left untranslated" test below, which is the whole point of
 * keeping the list explicit rather than computing it.
 */
const IDENTICAL_TO_SOURCE_OK: Record<string, string> = {
  'Sidebar.title': 'brand name',
  'Sidebar.beta': 'same word in Spanish',
  'Sidebar.defaultAvatar': 'same word in Spanish',
  'Header.defaultAvatar': 'same word in Spanish',
  'Dashboard.pipelineDonut.total': 'same word in Spanish',
  'Inbox.bubble.audio': 'same word in Spanish',
  'Inbox.replyQuote.audio': 'same word in Spanish',
  'Contacts.form.phonePlaceholder': 'sample phone number',
  'Contacts.form.companyPlaceholder': 'sample company name',
  'Broadcasts.detail.table.error': 'same word in Spanish',
  'Broadcasts.wizard.personalize.variables': 'same word in Spanish',
  'Broadcasts.wizard.scheduleSend.variables': 'same word in Spanish',
  'Automations.builder.branches.no': 'same word in Spanish',
  'Automations.builder.config.placeholderTime': 'time format, not prose',
  'Automations.builder.config.urlLabel': 'acronym',
  'Automations.builder.config.placeholderHeaders': 'literal JSON sample',
  'Automations.builder.config.placeholderBody': 'literal JSON sample',
  'Flows.list.beta': 'same word in Spanish',
  'Flows.summary.audio': 'same word in Spanish',
  'Settings.templates.btnUrl': 'acronym',
  'Settings.templates.phonePlaceholder': 'sample phone number',
  'Settings.sections.whatsapp': 'brand name',
  'Billing.subscription.noNextCharge': 'em dash placeholder',
  'Platform.columns.plan': 'same word in Spanish',
};

function load(locale: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8')
  ) as Record<string, unknown>;
}

function leaves(node: unknown, path = ''): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    return Object.entries(node).flatMap(([k, v]) =>
      leaves(v, path ? `${path}.${k}` : k)
    );
  }
  return [];
}

function loadKeys(locale: string): Set<string> {
  const out = new Set<string>();
  const walk = (node: unknown, path: string) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) {
        walk(v, path ? `${path}.${k}` : k);
      }
      return;
    }
    out.add(path);
  };
  walk(load(locale), '');
  return out;
}

/**
 * The ICU arguments a message uses, as `name:type` plus the selectors of
 * any plural/select branches — `count:plural(=1,other)`.
 *
 * Why parse instead of matching `/\{(\w+)\}/`: a regex cannot tell the
 * argument `{count}` from the branch body `{conversation}` inside
 * `{count, plural, =1 {conversation} other {conversations}}`, so it
 * reports a false mismatch for every plural in the catalogue — and a
 * translation that drops the `other` branch (which ICU requires, and
 * whose absence makes next-intl render the keypath) would slip past.
 * next-intl ships no AST helper, so this is a small recursive-descent
 * reader over the same grammar.
 */
function icuArguments(message: string): Set<string> {
  const found = new Set<string>();
  const closingBrace = (text: string, open: number): number => {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) return i;
    }
    return text.length;
  };

  const read = (text: string) => {
    let i = 0;
    while (i < text.length) {
      if (text[i] !== '{') {
        i++;
        continue;
      }
      let j = i + 1;
      while (text[j] === ' ') j++;
      const nameStart = j;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      const name = text.slice(nameStart, j);
      while (text[j] === ' ') j++;
      // `{{1}}` (a WhatsApp placeholder) and `{ }` are not ICU arguments.
      if (!name || (text[j] !== '}' && text[j] !== ',')) {
        i++;
        continue;
      }
      const end = closingBrace(text, i);
      if (text[j] === '}') {
        found.add(`${name}:simple`);
        i = end + 1;
        continue;
      }
      j++; // past the comma
      while (text[j] === ' ') j++;
      const typeStart = j;
      while (j < text.length && /[A-Za-z]/.test(text[j])) j++;
      const type = text.slice(typeStart, j);

      if (type === 'plural' || type === 'select' || type === 'selectordinal') {
        const body = text.slice(j, end);
        const selectors: string[] = [];
        let k = 0;
        while (k < body.length) {
          while (k < body.length && /[\s,]/.test(body[k])) k++;
          if (body[k] === '{') {
            const sub = closingBrace(body, k);
            read(body.slice(k + 1, sub)); // nested arguments
            k = sub + 1;
            continue;
          }
          const start = k;
          while (k < body.length && !/[\s{]/.test(body[k])) k++;
          const selector = body.slice(start, k);
          if (selector) selectors.push(selector);
        }
        found.add(`${name}:${type}(${selectors.sort().join(',')})`);
      } else {
        found.add(`${name}:${type}`);
      }
      i = end + 1;
    }
  };

  read(message);
  return found;
}

describe('message catalogue parity', () => {
  const source = loadKeys(SOURCE_LOCALE);

  it.each(TRANSLATED_LOCALES)('%s.json covers every en.json key', (locale) => {
    const translated = loadKeys(locale);
    const missing = [...source].filter((k) => !translated.has(k)).sort();
    expect(missing, `${locale}.json is missing these keys`).toEqual([]);
  });

  it.each(TRANSLATED_LOCALES)('%s.json has no orphaned keys', (locale) => {
    const translated = loadKeys(locale);
    const orphaned = [...translated].filter((k) => !source.has(k)).sort();
    expect(orphaned, `${locale}.json has keys absent from en.json`).toEqual([]);
  });
});

function argumentNames(signatures: Set<string>): Set<string> {
  return new Set([...signatures].map((s) => s.slice(0, s.indexOf(':'))));
}

describe('ICU placeholders survive translation', () => {
  const sourceEntries = new Map(leaves(load(SOURCE_LOCALE)));

  // A translation that renames `{count}`, drops a `{date, date, …}`
  // format or loses the `other` plural branch does not throw: next-intl
  // reports the error to onError and renders the keypath, so the bug is
  // invisible until a user on that locale sees "Billing.trialEndsIn".
  it.each(TRANSLATED_LOCALES)(
    '%s.json interpolates exactly the arguments en.json does',
    (locale) => {
      const mismatches: string[] = [];
      for (const [key, value] of leaves(load(locale))) {
        const expected = argumentNames(
          icuArguments(sourceEntries.get(key) ?? '')
        );
        const actual = argumentNames(icuArguments(value));
        const missing = [...expected].filter((a) => !actual.has(a));
        const extra = [...actual].filter((a) => !expected.has(a));
        if (missing.length || extra.length) {
          mismatches.push(
            `${key} — missing [${missing.join(', ')}] extra [${extra.join(', ')}]`
          );
        }
      }
      expect(mismatches.sort()).toEqual([]);
    }
  );

  // ICU requires an `other` branch; without it the message does not parse
  // and next-intl renders the keypath. Deliberately not "the same branches
  // as en": Korean has no plural forms, so ko.json collapses
  // `{count, plural, …}` to a plain `{count}` on purpose.
  it.each(TRANSLATED_LOCALES)(
    '%s.json never leaves a plural without `other`',
    (locale) => {
      const broken = leaves(load(locale))
        .flatMap(([key, value]) =>
          [...icuArguments(value)]
            .filter((sig) => /:(plural|select|selectordinal)\(/.test(sig))
            .filter((sig) => !/[(,]other[,)]/.test(sig))
            .map((sig) => `${key} — ${sig}`)
        )
        .sort();
      expect(broken).toEqual([]);
    }
  );

  // Spanish does pluralise, so the default locale is held to the stricter
  // rule: same argument types and the same set of plural selectors as en.
  it(`${DEFAULT_LOCALE}.json keeps en.json's argument types and plural branches`, () => {
    const mismatches: string[] = [];
    for (const [key, value] of leaves(load(DEFAULT_LOCALE))) {
      const expected = icuArguments(sourceEntries.get(key) ?? '');
      const actual = icuArguments(value);
      const missing = [...expected].filter((a) => !actual.has(a));
      const extra = [...actual].filter((a) => !expected.has(a));
      if (missing.length || extra.length) {
        mismatches.push(
          `${key} — missing [${missing.join(', ')}] extra [${extra.join(', ')}]`
        );
      }
    }
    expect(mismatches.sort()).toEqual([]);
  });
});

describe(`${DEFAULT_LOCALE}.json is actually translated`, () => {
  const sourceEntries = new Map(leaves(load(SOURCE_LOCALE)));

  it('leaves nothing in English outside the documented list', () => {
    const untranslated = leaves(load(DEFAULT_LOCALE))
      .filter(
        ([key, value]) =>
          sourceEntries.get(key) === value && !(key in IDENTICAL_TO_SOURCE_OK)
      )
      .map(([key]) => key)
      .sort();
    expect(
      untranslated,
      'these still read exactly like en.json — translate them, or add them to IDENTICAL_TO_SOURCE_OK with a reason'
    ).toEqual([]);
  });

  it('keeps the allow-list honest', () => {
    const stale = Object.keys(IDENTICAL_TO_SOURCE_OK)
      .filter((key) => !sourceEntries.has(key))
      .sort();
    expect(stale, 'these allow-listed keys no longer exist in en.json').toEqual(
      []
    );
  });
});
