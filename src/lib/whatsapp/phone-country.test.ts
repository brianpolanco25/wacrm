import { describe, expect, it } from 'vitest';

import { countryFromPhone } from './phone-country';

// s10.2: Meta prices by the RECIPIENT's market, so the country must come
// out of the phone number — and the Dominican Republic, which shares +1
// with the United States, must not be billed as North America.

describe('countryFromPhone', () => {
  it.each([
    ['+1 809 555 0100', 'DO'],
    ['18295550100', 'DO'],
    ['+1 (849) 555-0100', 'DO'],
    ['+1 787 555 0100', 'PR'],
    ['+1 876 555 0100', 'JM'],
    ['+1 415 555 1212', 'US'],
    ['+1 416 555 1212', 'US'], // Canada: same Meta market as the US
    ['+52 55 1234 5678', 'MX'],
    ['+57 300 123 4567', 'CO'],
    ['+55 11 91234 5678', 'BR'],
    ['+34 612 345 678', 'ES'],
    ['+509 3412 3456', 'HT'],
    ['+593 99 123 4567', 'EC'],
    ['+502 5123 4567', 'GT'],
    ['+7 912 345 6789', 'RU'],
  ])('%s → %s', (phone, country) => {
    expect(countryFromPhone(phone)).toBe(country);
  });

  it.each([
    ['empty', ''],
    ['null', null],
    ['too short', '+1809'],
    ['a +1 number of the wrong length', '+1 809 555 01'],
    ['a national number with trunk 0', '0809 555 0100'],
    ['an unknown calling code', '+999 1234 5678'],
  ])('is null for %s (never guessed)', (_label, phone) => {
    expect(countryFromPhone(phone)).toBeNull();
  });
});
