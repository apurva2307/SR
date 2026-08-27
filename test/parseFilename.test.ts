import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilename, type ParsedRecord } from '../src/ingest/parseFilename.ts';

/** Narrow to a success, failing the test with the rejection detail if it is not. */
function ok(filename: string): ParsedRecord {
  const r = parseFilename(filename);
  assert.equal(r.ok, true, `expected "${filename}" to parse, got: ${r.ok ? '' : r.detail}`);
  return r as ParsedRecord;
}

const PPO = '410221100347';

test('the common shape: PPO, separator, name', () => {
  for (const f of [
    `${PPO}_RAM KUMAR SHARMA.pdf`,
    `${PPO} RAM KUMAR SHARMA.pdf`,
    `${PPO}-RAM KUMAR SHARMA.pdf`,
    `${PPO}.RAM KUMAR SHARMA.pdf`,
    `${PPO} - Ram Kumar Sharma.pdf`,
    `${PPO}__RAM  KUMAR   SHARMA.pdf`,
  ]) {
    const r = ok(f);
    assert.equal(r.ppoNormalized, PPO, f);
    assert.equal(r.nameNormalized, 'RAM KUMAR SHARMA', f);
    assert.equal(r.pattern, 'PPO_LEADING', f);
  }
});

test('PPO punctuation and a PPO label are both tolerated', () => {
  assert.equal(ok('4102-2110-0347_Ram Kumar Sharma.pdf').ppoNormalized, PPO);
  assert.equal(ok('4102 2110 0347 Ram Kumar Sharma.pdf').ppoNormalized, PPO);
  assert.equal(ok(`PPO ${PPO} Ram Kumar Sharma.pdf`).ppoNormalized, PPO);
  assert.equal(ok(`PPO-${PPO}_Ram Kumar Sharma.pdf`).ppoNormalized, PPO);
});

test('the extension is matched case-insensitively', () => {
  assert.equal(ok(`${PPO}_Ram Kumar Sharma.PDF`).ppoNormalized, PPO);
  assert.equal(ok(`${PPO}_Ram Kumar Sharma.Pdf`).ppoNormalized, PPO);
});

test('surrounding whitespace does not defeat the parse', () => {
  const r = ok(`   ${PPO}_Ram Kumar Sharma .pdf`);
  assert.equal(r.employeeName, 'Ram Kumar Sharma');
});

test('name first, PPO trailing', () => {
  const r = ok(`SMT. SUNITA DEVI_${PPO}.pdf`);
  assert.equal(r.pattern, 'PPO_TRAILING');
  assert.equal(r.ppoNormalized, PPO);
  assert.equal(r.employeeName, 'SMT. SUNITA DEVI');
  assert.equal(r.nameNormalized, 'SUNITA DEVI');
});

test('PPO in brackets or parentheses', () => {
  for (const f of [
    `Ram Kumar Sharma (${PPO}).pdf`,
    `Ram Kumar Sharma [${PPO}].pdf`,
    `Ram Kumar Sharma [PPO ${PPO}].pdf`,
    `Ram Kumar Sharma(${PPO}).pdf`,
  ]) {
    const r = ok(f);
    assert.equal(r.pattern, 'PPO_BRACKETED', f);
    assert.equal(r.ppoNormalized, PPO, f);
    assert.equal(r.nameNormalized, 'RAM KUMAR SHARMA', f);
  }
});

test('filesystem and workflow debris is stripped from the tail', () => {
  for (const f of [
    `${PPO}_RAM KUMAR SHARMA - Copy.pdf`,
    `${PPO}_RAM KUMAR SHARMA - Copy (2).pdf`,
    `${PPO}_RAM KUMAR SHARMA (1).pdf`,
    `${PPO}_RAM KUMAR SHARMA_SR.pdf`,
    `${PPO}_RAM KUMAR SHARMA - service record.pdf`,
    `${PPO}_RAM KUMAR SHARMA_scan.pdf`,
  ]) {
    assert.equal(ok(f).nameNormalized, 'RAM KUMAR SHARMA', f);
  }
});

test('debris stripping never eats the whole name', () => {
  // "Copy" is the entire name here; stripping it would leave nothing, so it stays.
  const r = ok(`${PPO}_Copy.pdf`);
  assert.equal(r.nameNormalized, 'COPY');
});

test('legacy PPO lengths are indexed but flagged', () => {
  const r = ok('123456_LATE SHRI B N MISHRA.pdf');
  assert.equal(r.ppoNormalized, '123456');
  assert.equal(r.ppoVerdict, 'NON_STANDARD');
  assert.equal(r.nameNormalized, 'B N MISHRA');

  assert.equal(ok(`${PPO}_Ram Sharma.pdf`).ppoVerdict, 'STANDARD');
});

test('non-Latin names parse and survive normalisation', () => {
  const r = ok(`${PPO}_राम कुमार शर्मा.pdf`);
  assert.equal(r.ppoNormalized, PPO);
  assert.equal(r.employeeName, 'राम कुमार शर्मा');
  assert.equal(r.nameNormalized, 'राम कुमार शर्मा');
});

test('a year or other digits after the PPO stay in the name', () => {
  const r = ok(`${PPO}_2019 RAM KUMAR.pdf`);
  assert.equal(r.ppoNormalized, PPO);
  assert.equal(r.nameNormalized, '2019 RAM KUMAR');
});

test('all three derived search forms are populated on every success', () => {
  const r = ok(`${PPO}_Shri Ram Kumar Sharma.pdf`);
  assert.equal(r.employeeName, 'Shri Ram Kumar Sharma');
  assert.equal(r.nameNormalized, 'RAM KUMAR SHARMA');
  assert.equal(r.nameSorted, 'KUMAR RAM SHARMA');
});

test('word order does not change the sorted key', () => {
  const a = ok(`${PPO}_Ram Kumar Sharma.pdf`);
  const b = ok(`${PPO}_Sharma Ram Kumar.pdf`);
  assert.equal(a.nameSorted, b.nameSorted);
  assert.notEqual(a.nameNormalized, b.nameNormalized);
});

// ---------------------------------------------------------------------------
// Quarantine. Nothing below is guessed into the catalogue (§8.1).
// ---------------------------------------------------------------------------

test('files with no PPO at all are rejected, not guessed', () => {
  for (const f of ['Service Record.pdf', 'scan0001.pdf', 'untitled.pdf']) {
    const r = parseFilename(f);
    assert.equal(r.ok, false, f);
  }
});

test('a PPO with no name is a distinct, more actionable failure', () => {
  const r = parseFilename(`${PPO}.pdf`);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'NO_NAME');
  assert.equal(r.ok === false && r.suggestedPpo, PPO);
});

test('an out-of-range PPO is quarantined with both values pre-filled', () => {
  const r = parseFilename('1234_X Y.pdf');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'PPO_OUT_OF_RANGE');
  assert.equal(r.ok === false && r.suggestedPpo, '1234');
  assert.equal(r.ok === false && r.suggestedName, 'X Y');

  const long = parseFilename('410221100347999999_Ram Sharma.pdf');
  assert.equal(long.ok === false && long.reason, 'PPO_OUT_OF_RANGE');
});

test('non-PDF files are rejected before anything else is attempted', () => {
  const r = parseFilename(`${PPO}_Ram Kumar Sharma.tiff`);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'NOT_A_PDF');
});

test('every rejection carries a detail a custodian can act on', () => {
  for (const f of ['scan0001.pdf', `${PPO}.pdf`, '1234_X Y.pdf', 'x.tiff']) {
    const r = parseFilename(f);
    assert.equal(r.ok, false, f);
    assert.ok(r.ok === false && r.detail.length > 10, `weak detail for ${f}`);
  }
});

test('site-specific patterns can be supplied without touching the built-ins', () => {
  // A folder that files as "SR-<name>-<ppo>" with no other separator.
  const extra = [{
    name: 'PPO_TRAILING' as const,
    re: /^SR~(?<name>.+)~(?<ppo>\d+)$/u,
  }];
  const r = parseFilename(`SR~Ram Kumar Sharma~${PPO}.pdf`, { extraPatterns: extra });
  assert.equal(r.ok, true);
  assert.equal(r.ok === true && r.ppoNormalized, PPO);
});
