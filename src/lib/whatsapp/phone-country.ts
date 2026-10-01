// ============================================================
// Country of a phone number, from its international calling code
// (fase 10, s10.2). Meta prices each delivered message by the market of
// the RECIPIENT's number, so the rate card (`src/lib/billing/meta-rates.ts`)
// needs the ISO-3166 alpha-2 country of `contacts.phone`.
//
// Not a full numbering plan: a table of calling codes (ITU-T E.164,
// prefix-free by design, so the longest match wins) and, for the shared
// +1 zone, the area codes of the Caribbean countries — the Dominican
// Republic is +1 809/829/849 and must NOT read as the United States.
// Any other +1 number reads as `US`: Canada shares Meta's «North America»
// market with it, so the price is the same.
//
// A number whose calling code is not in the table gives `null`, and the
// rate card treats it as an unknown market (→ `rest_of_world` if that
// market has a rate, otherwise a visible error). It is never guessed.
// Lives next to `phone-utils.ts` (same sanitising) instead of inside it,
// so that file keeps its formatting.
// ============================================================

import { sanitizePhoneForMeta } from './phone-utils';

/** Calling code (without +) → country, for every code other than +1. */
const CALLING_CODES: Readonly<Record<string, string>> = {
  // Latin America and the Caribbean outside the +1 zone
  '52': 'MX',
  '57': 'CO',
  '55': 'BR',
  '54': 'AR',
  '56': 'CL',
  '51': 'PE',
  '58': 'VE',
  '593': 'EC',
  '591': 'BO',
  '595': 'PY',
  '598': 'UY',
  '502': 'GT',
  '503': 'SV',
  '504': 'HN',
  '505': 'NI',
  '506': 'CR',
  '507': 'PA',
  '509': 'HT',
  '53': 'CU',
  '501': 'BZ',
  '592': 'GY',
  '597': 'SR',
  '297': 'AW',
  // Europe
  '34': 'ES',
  '351': 'PT',
  '44': 'GB',
  '33': 'FR',
  '49': 'DE',
  '39': 'IT',
  '31': 'NL',
  '32': 'BE',
  '41': 'CH',
  '43': 'AT',
  '353': 'IE',
  '45': 'DK',
  '46': 'SE',
  '47': 'NO',
  '358': 'FI',
  '48': 'PL',
  '420': 'CZ',
  '30': 'GR',
  '40': 'RO',
  '36': 'HU',
  '380': 'UA',
  '90': 'TR',
  '7': 'RU',
  // Rest of the world
  '82': 'KR',
  '81': 'JP',
  '86': 'CN',
  '91': 'IN',
  '61': 'AU',
  '64': 'NZ',
  '27': 'ZA',
  '234': 'NG',
  '20': 'EG',
  '212': 'MA',
  '971': 'AE',
  '966': 'SA',
  '972': 'IL',
  '62': 'ID',
  '63': 'PH',
  '60': 'MY',
  '65': 'SG',
  '66': 'TH',
  '84': 'VN',
  '92': 'PK',
  '880': 'BD',
};

/** Area codes of the +1 zone that are NOT the United States or Canada. */
const NANP_AREA_CODES: Readonly<Record<string, string>> = {
  '809': 'DO',
  '829': 'DO',
  '849': 'DO',
  '787': 'PR',
  '939': 'PR',
  '876': 'JM',
  '658': 'JM',
  '242': 'BS',
  '246': 'BB',
  '268': 'AG',
  '264': 'AI',
  '284': 'VG',
  '340': 'VI',
  '345': 'KY',
  '441': 'BM',
  '473': 'GD',
  '649': 'TC',
  '664': 'MS',
  '670': 'MP',
  '671': 'GU',
  '684': 'AS',
  '721': 'SX',
  '758': 'LC',
  '767': 'DM',
  '784': 'VC',
  '868': 'TT',
  '869': 'KN',
};

/**
 * ISO-3166 alpha-2 country of an international phone number
 * (`+1 809 555 0100`, `18095550100`, `+52 55 1234 5678`), or `null` when
 * the calling code is not known or the number is too short to carry one.
 */
export function countryFromPhone(
  phone: string | null | undefined
): string | null {
  const digits = sanitizePhoneForMeta(phone ?? '');
  // Shortest real international number: code + 6 digits.
  if (digits.length < 7 || digits.startsWith('0')) return null;

  if (digits.startsWith('1')) {
    if (digits.length !== 11) return null;
    return NANP_AREA_CODES[digits.slice(1, 4)] ?? 'US';
  }

  for (const length of [3, 2, 1]) {
    const country = CALLING_CODES[digits.slice(0, length)];
    if (country) return country;
  }
  return null;
}
