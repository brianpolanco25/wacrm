// ============================================================
// The company profile of the paid onboarding (s9.6, decision 6 of the
// human): name, country, phone, industry and team size.
//
// Pure and import-free on purpose: the form (browser) and the route
// (server) validate with the same rules, and migration 073 backs the
// shapes that matter with CHECKs (`accounts_country_format`,
// `accounts_team_size_check`, `accounts_phone_length`,
// `accounts_industry_length`).
// ============================================================

/**
 * Countries offered in the form, ISO-3166 alpha-2. A short list, not
 * the whole standard: Cabbity sells to Latin America and Spain first,
 * plus the markets the other two catalogues (en, ko) speak to. The UI
 * names them with `Intl.DisplayNames` in the user's locale, so no
 * translation table is needed for them.
 */
export const COUNTRIES = [
  'DO',
  'MX',
  'CO',
  'PE',
  'CL',
  'AR',
  'EC',
  'VE',
  'GT',
  'SV',
  'HN',
  'NI',
  'CR',
  'PA',
  'PR',
  'CU',
  'BO',
  'PY',
  'UY',
  'BR',
  'ES',
  'PT',
  'US',
  'CA',
  'GB',
  'FR',
  'DE',
  'IT',
  'KR',
] as const;

/** Industry keys; the labels live in `Onboarding.company.industries`. */
export const INDUSTRIES = [
  'retail',
  'services',
  'health',
  'education',
  'real_estate',
  'hospitality',
  'technology',
  'finance',
  'manufacturing',
  'logistics',
  'other',
] as const;

/** Team sizes, exactly the list of `accounts_team_size_check` (073). */
export const TEAM_SIZES = ['1', '2-5', '6-20', '21-50', '51+'] as const;

export type Country = (typeof COUNTRIES)[number];
export type Industry = (typeof INDUSTRIES)[number];
export type TeamSize = (typeof TEAM_SIZES)[number];

/** Same ceiling as `PATCH /api/account` for the company name. */
export const MAX_NAME_LEN = 80;

export interface CompanyProfile {
  name: string;
  country: Country;
  phone: string;
  industry: Industry;
  teamSize: TeamSize;
}

export type CompanyField = keyof CompanyProfile;

export type ProfileValidation =
  | { ok: true; value: CompanyProfile }
  | { ok: false; field: CompanyField; error: string };

function includes<T extends string>(
  list: readonly T[],
  value: unknown
): value is T {
  return (
    typeof value === 'string' && (list as readonly string[]).includes(value)
  );
}

/**
 * Loose on purpose: people type phones with spaces, dashes, dots and
 * brackets. What is checked is that it is a phone at all — only those
 * characters, an optional leading `+`, and between 6 and 15 digits
 * (E.164 tops out at 15). The CHECK of 073 caps the stored text at 32.
 */
export function normalizePhone(raw: string): string | null {
  const phone = raw.trim().replace(/\s+/g, ' ');
  if (!/^\+?[0-9 ().-]+$/.test(phone)) return null;
  const digits = phone.replace(/\D/g, '').length;
  if (digits < 6 || digits > 15) return null;
  if (phone.length > 32) return null;
  return phone;
}

/**
 * Validate the body of `POST /api/onboarding/company`. Returns the first
 * field that fails, so the form can put the message next to it; the
 * messages are for the API caller, the form shows its own translations.
 */
export function validateCompanyProfile(input: unknown): ProfileValidation {
  const body = (input && typeof input === 'object' ? input : {}) as Record<
    string,
    unknown
  >;

  if (typeof body.name !== 'string' || !body.name.trim()) {
    return { ok: false, field: 'name', error: "'name' is required" };
  }
  const name = body.name.trim();
  if (name.length > MAX_NAME_LEN) {
    return {
      ok: false,
      field: 'name',
      error: `'name' must be ${MAX_NAME_LEN} characters or fewer`,
    };
  }

  const country =
    typeof body.country === 'string' ? body.country.trim().toUpperCase() : '';
  if (!includes(COUNTRIES, country)) {
    return {
      ok: false,
      field: 'country',
      error: "'country' must be one of the offered ISO-3166 alpha-2 codes",
    };
  }

  const phone =
    typeof body.phone === 'string' ? normalizePhone(body.phone) : null;
  if (!phone) {
    return {
      ok: false,
      field: 'phone',
      error: "'phone' must be a phone number (6 to 15 digits)",
    };
  }

  if (!includes(INDUSTRIES, body.industry)) {
    return {
      ok: false,
      field: 'industry',
      error: `'industry' must be one of: ${INDUSTRIES.join(', ')}`,
    };
  }

  if (!includes(TEAM_SIZES, body.teamSize)) {
    return {
      ok: false,
      field: 'teamSize',
      error: `'teamSize' must be one of: ${TEAM_SIZES.join(', ')}`,
    };
  }

  return {
    ok: true,
    value: {
      name,
      country,
      phone,
      industry: body.industry,
      teamSize: body.teamSize,
    },
  };
}

/** The `accounts` columns of the profile, as the database names them. */
export interface AccountProfileRow {
  name?: string | null;
  country: string | null;
  phone: string | null;
  industry: string | null;
  team_size: string | null;
}

/**
 * Every field of step 1 is there. Mirrors the CHECK
 * `accounts_onboarding_needs_profile` (073): the stamp is refused
 * without these four.
 */
export function isProfileComplete(
  row: AccountProfileRow | null | undefined
): boolean {
  return Boolean(
    row && row.country && row.phone && row.industry && row.team_size
  );
}
