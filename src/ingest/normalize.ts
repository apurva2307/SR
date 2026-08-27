// §7 — the three derived forms that make name search work, and PPO
// normalisation. Pure functions: no I/O, no database, fully testable.

/**
 * Leading honorifics, stripped from name_normalized only. employee_name keeps
 * whatever the filename said.
 *
 * Two-letter entries are safe because punctuation is converted to whitespace
 * BEFORE tokenising: "M.S. Rao" becomes tokens [M, S, RAO], so a single "MS"
 * token really is the honorific. The residual ambiguity is a filename that
 * writes initials without periods ("MS RAO" for M.S. Rao) — unavoidable, and
 * the reason record_aliases exists (§13).
 */
export const HONORIFICS = new Set([
  'SHRI', 'SHREE', 'SRI', 'SH',
  'SMT', 'SMTI', 'SHRIMATI', 'SHRIMATHI',
  'KUM', 'KUMARI', 'KM',
  'DR', 'PROF', 'ER',
  'MR', 'MRS', 'MS', 'MISS',
  'LATE',
  'SARDAR', 'SARDARNI', 'HAJI',
  // Devanagari, since plenty of these folders are not in English.
  'श्री', 'श्रीमती', 'कुमारी', 'स्वर्गीय', 'डॉ',
]);

/** Digits only. "4102-2110/0347" and "4102 2110 0347" collapse to the same key. */
export function normalizePpo(raw: string): string {
  return raw.replace(/\D/gu, '');
}

export interface PpoRules {
  standardLength: number;
  minLength: number;
  maxLength: number;
}

export const DEFAULT_PPO_RULES: PpoRules = { standardLength: 12, minLength: 6, maxLength: 14 };

export type PpoVerdict = 'STANDARD' | 'NON_STANDARD' | 'OUT_OF_RANGE';

/**
 * STANDARD is today's 12 digits. NON_STANDARD is a legacy length that is still
 * common and still valid — indexed, but flagged so a custodian can see how
 * much of the folder predates the current format. OUT_OF_RANGE is quarantined.
 */
export function classifyPpo(digits: string, rules: PpoRules = DEFAULT_PPO_RULES): PpoVerdict {
  if (digits.length === rules.standardLength) return 'STANDARD';
  if (digits.length >= rules.minLength && digits.length <= rules.maxLength) return 'NON_STANDARD';
  return 'OUT_OF_RANGE';
}

/**
 * Everything that is not a letter, a mark, a digit, or whitespace becomes a
 * space.
 *
 * \p{M} is not optional. Devanagari vowel signs and the virama are combining
 * marks, not letters: without \p{M} in the keep set, "राम" (र + ◌ा + म) loses
 * its vowel sign and normalises to "र म" — every non-Latin name in the folder
 * silently shredded into fragments.
 */
function depunctuate(raw: string): string {
  return raw.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ');
}

export function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/gu, ' ').trim();
}

/**
 * Uppercase, honorifics dropped from the front, punctuation removed,
 * whitespace collapsed. "Shri Ram Kumar Sharma" -> "RAM KUMAR SHARMA".
 *
 * Honorifics are stripped from the front only. A name whose middle token
 * happens to look like one keeps it, which is the safer failure.
 */
export function normalizeName(raw: string): string {
  const tokens = collapseWhitespace(depunctuate(raw).toUpperCase()).split(' ').filter(Boolean);

  // Drop the leading run of honorifics — "LATE SHRI B N MISHRA" carries two.
  const firstRealToken = tokens.findIndex((t) => !HONORIFICS.has(t));

  // A name that is nothing but honorifics is kept whole. There is no name to
  // recover, and returning a fragment would be worse than returning the input.
  const kept = firstRealToken === -1 ? tokens : tokens.slice(firstRealToken);
  return kept.join(' ');
}

/**
 * The cheap trick that pays for itself: tokens sorted alphabetically, so
 * surname-first and given-name-first queries collapse onto the same key.
 * "RAM KUMAR SHARMA" and "SHARMA RAM KUMAR" both become "KUMAR RAM SHARMA".
 */
export function sortNameTokens(normalized: string): string {
  return normalized.split(' ').filter(Boolean).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(' ');
}

/** All three derived forms in one call — the ingester never computes them apart. */
export function deriveNameForms(rawName: string): {
  employeeName: string;
  nameNormalized: string;
  nameSorted: string;
} {
  const employeeName = collapseWhitespace(rawName);
  const nameNormalized = normalizeName(employeeName);
  return { employeeName, nameNormalized, nameSorted: sortNameTokens(nameNormalized) };
}
