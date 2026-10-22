// §8 — the filename is the only metadata this system gets, so it is the
// ceiling on everything downstream.
//
// The rule this file exists to enforce: ingestion never invents metadata.
// Anything that does not parse confidently is quarantined and stays invisible
// to search until a human resolves it. A fuzzy guess that reaches the
// catalogue produces a record findable under the wrong name, which is worse
// than one that is not findable at all.

import {
  DEFAULT_PPO_RULES,
  classifyPpo,
  collapseWhitespace,
  deriveNameForms,
  normalizePpo,
  type PpoRules,
  type PpoVerdict,
} from './normalize.ts';

export type ParseFailure =
  | 'NOT_A_PDF'
  | 'NO_PATTERN_MATCH'
  | 'PPO_OUT_OF_RANGE'
  | 'NO_NAME';

export type PatternName = 'PPO_ALNUM_LEADING' | 'PPO_LEADING' | 'PPO_BRACKETED' | 'PPO_TRAILING';

export interface ParsedRecord {
  ok: true;
  pattern: PatternName;
  ppoRaw: string;
  ppoNormalized: string;
  ppoVerdict: Exclude<PpoVerdict, 'OUT_OF_RANGE'>;
  employeeName: string;
  nameNormalized: string;
  nameSorted: string;
}

export interface ParseRejection {
  ok: false;
  reason: ParseFailure;
  detail: string;
  /** Pre-filled for the custodian's quarantine console — a suggestion, never a decision. */
  suggestedPpo?: string;
  suggestedName?: string;
}

export type ParseResult = ParsedRecord | ParseRejection;

/** Every quarantine reason the parser can produce maps to one DB reason (§8.1). */
export function toQuarantineReason(_failure: ParseFailure): 'UNPARSEABLE' {
  return 'UNPARSEABLE';
}

// Filesystem and workflow debris. Trailing only, and only when a name survives.
const COPY_ARTIFACT = /[\s._-]*(?:-\s*copy(?:\s*\(\d{1,3}\))?|\(\d{1,3}\))\s*$/iu;
// `compressed` earns its place: bulk PDF optimisers append it to every file
// they touch, so a whole folder arrives with it and every employee name in the
// catalogue ends up carrying it.
const NOISE_SUFFIX =
  /[\s._-]+(?:s\.?r\.?|service[\s._-]*record|copy|scan|final|new|old|compressed)\s*$/iu;

const PPO_RUN = String.raw`\d[\d\s\-\/]*\d|\d`;
// Older PPOs carry a short bank/office code between two digit groups:
// "0383-PSB-2732". Letters are only allowed when digits follow them, so a
// plain "0196030503 - NANHOO" never has its name swallowed into the PPO.
const PPO_ALNUM_RUN = String.raw`\d+[\s\-\/]*\p{L}{2,4}[\s\-\/]*\d+`;
const LABEL = String.raw`(?:ppo[\s._:-]*)?`;
const SEP = String.raw`[\s._\-]+`;

const PATTERNS: ReadonlyArray<{ name: PatternName; re: RegExp }> = [
  // 0383- PSB-2732 BHAGWAT PRASAD — tried first, or PPO_LEADING takes "0383"
  // alone and quarantines it as too short.
  { name: 'PPO_ALNUM_LEADING', re: new RegExp(String.raw`^${LABEL}(?<ppo>${PPO_ALNUM_RUN})${SEP}(?<name>.+)$`, 'iu') },
  // 410221100347_RAM KUMAR SHARMA   |   PPO 4102-2110-0347 - Ram Sharma
  { name: 'PPO_LEADING', re: new RegExp(String.raw`^${LABEL}(?<ppo>${PPO_RUN})${SEP}(?<name>.+)$`, 'iu') },
  // Ram Kumar Sharma (410221100347)   |   Ram Sharma [PPO 410221100347]
  { name: 'PPO_BRACKETED', re: new RegExp(String.raw`^(?<name>.+?)[\s._-]*[\(\[]\s*${LABEL}(?<ppo>${PPO_RUN})\s*[\)\]]\s*$`, 'iu') },
  // SMT. SUNITA DEVI_410221100348
  { name: 'PPO_TRAILING', re: new RegExp(String.raw`^(?<name>.+?)${SEP}${LABEL}(?<ppo>${PPO_RUN})\s*$`, 'iu') },
];

function stripDebris(stem: string): string {
  let out = collapseWhitespace(stem);
  // Twice: "Ram Sharma - Copy (2)" and "…_SR - Copy" both occur.
  for (let i = 0; i < 2; i++) {
    for (const re of [COPY_ARTIFACT, NOISE_SUFFIX]) {
      const next = out.replace(re, '');
      // Only accept the strip if something with a letter survives.
      if (next !== out && /\p{L}/u.test(next)) out = collapseWhitespace(next);
    }
  }
  return out;
}

export interface ParseOptions {
  ppoRules?: PpoRules;
  /** Site-specific patterns from settings, tried after the built-ins (§8). */
  extraPatterns?: ReadonlyArray<{ name: PatternName; re: RegExp }>;
}

/**
 * Parse one filename into a catalogue row, or a reason it cannot be one.
 *
 * Takes a filename, not a path: path handling is the caller's problem and is
 * realpath-guarded elsewhere (§4.2).
 */
export function parseFilename(filename: string, opts: ParseOptions = {}): ParseResult {
  const rules = opts.ppoRules ?? DEFAULT_PPO_RULES;
  const raw = filename.trim();

  if (!/\.pdf$/iu.test(raw)) {
    return { ok: false, reason: 'NOT_A_PDF', detail: `Not a PDF: ${filename}` };
  }

  const stem = stripDebris(raw.replace(/\.pdf$/iu, ''));

  if (stem === '') {
    return { ok: false, reason: 'NO_PATTERN_MATCH', detail: 'Filename is empty once the extension is removed.' };
  }

  // A stem with no letters at all is a PPO with no name attached — a distinct
  // and much more actionable failure than "could not parse".
  if (!/\p{L}/u.test(stem)) {
    const digits = normalizePpo(stem);
    return {
      ok: false,
      reason: 'NO_NAME',
      detail: 'Filename carries a PPO number but no employee name.',
      ...(digits ? { suggestedPpo: digits } : {}),
    };
  }

  for (const { name, re } of [...PATTERNS, ...(opts.extraPatterns ?? [])]) {
    const m = re.exec(stem);
    const ppoRaw = m?.groups?.['ppo'];
    const nameRaw = m?.groups?.['name'];
    if (!m || !ppoRaw || !nameRaw) continue;

    const ppoNormalized = normalizePpo(ppoRaw);
    const verdict = classifyPpo(ppoNormalized, rules);
    const forms = deriveNameForms(nameRaw);

    if (verdict === 'OUT_OF_RANGE') {
      return {
        ok: false,
        reason: 'PPO_OUT_OF_RANGE',
        detail:
          `PPO "${ppoNormalized}" has ${ppoNormalized.length} digits; ` +
          `expected ${rules.minLength}–${rules.maxLength}.`,
        suggestedPpo: ppoNormalized,
        suggestedName: forms.employeeName,
      };
    }

    if (forms.nameNormalized === '') {
      return {
        ok: false,
        reason: 'NO_NAME',
        detail: 'Nothing usable remains of the employee name.',
        suggestedPpo: ppoNormalized,
      };
    }

    return {
      ok: true,
      pattern: name,
      ppoRaw: collapseWhitespace(ppoRaw),
      ppoNormalized,
      ppoVerdict: verdict,
      ...forms,
    };
  }

  return {
    ok: false,
    reason: 'NO_PATTERN_MATCH',
    detail: `No known pattern matched "${filename}".`,
    ...(normalizePpo(stem).length >= rules.minLength ? { suggestedPpo: normalizePpo(stem) } : {}),
  };
}
