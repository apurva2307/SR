import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPpo,
  deriveNameForms,
  normalizeName,
  normalizePpo,
  sortNameTokens,
} from '../src/ingest/normalize.ts';

test('normalizePpo keeps digits only', () => {
  assert.equal(normalizePpo('410221100347'), '410221100347');
  assert.equal(normalizePpo('4102-2110-0347'), '410221100347');
  assert.equal(normalizePpo('4102 2110 0347'), '410221100347');
  assert.equal(normalizePpo('4102/2110/0347'), '410221100347');
  assert.equal(normalizePpo('PPO: 4102.2110.0347'), '410221100347');
  assert.equal(normalizePpo('no digits here'), '');
});

test('classifyPpo separates current, legacy, and junk lengths', () => {
  assert.equal(classifyPpo('410221100347'), 'STANDARD');      // 12
  assert.equal(classifyPpo('123456'), 'NON_STANDARD');        // 6, legacy
  assert.equal(classifyPpo('41022110034799'), 'NON_STANDARD');// 14, upper bound
  assert.equal(classifyPpo('12345'), 'OUT_OF_RANGE');         // 5, too short
  assert.equal(classifyPpo('410221100347999'), 'OUT_OF_RANGE');
  assert.equal(classifyPpo(''), 'OUT_OF_RANGE');
});

test('normalizeName uppercases, depunctuates, and collapses whitespace', () => {
  assert.equal(normalizeName('Ram Kumar Sharma'), 'RAM KUMAR SHARMA');
  assert.equal(normalizeName('  Ram   Kumar    Sharma  '), 'RAM KUMAR SHARMA');
  assert.equal(normalizeName('B.N. Mishra'), 'B N MISHRA');
  assert.equal(normalizeName('D`Souza, Anthony'), 'D SOUZA ANTHONY');
});

test('normalizeName strips leading honorifics, including stacked ones', () => {
  assert.equal(normalizeName('Shri Ram Kumar Sharma'), 'RAM KUMAR SHARMA');
  assert.equal(normalizeName('SMT. SUNITA DEVI'), 'SUNITA DEVI');
  assert.equal(normalizeName('Late Shri B.N. Mishra'), 'B N MISHRA');
  assert.equal(normalizeName('Dr. Kumari Anita Verma'), 'ANITA VERMA');
  assert.equal(normalizeName('श्री राम कुमार शर्मा'), 'राम कुमार शर्मा');
});

test('honorifics are stripped from the front only', () => {
  // A middle token that happens to look like an honorific is kept: the safer failure.
  assert.equal(normalizeName('Ram Shri Kumar'), 'RAM SHRI KUMAR');
  // Periods become spaces before tokenising, so real initials survive as
  // single letters and never collide with the two-letter honorifics.
  assert.equal(normalizeName('M.S. Rao'), 'M S RAO');
});

test('a name made only of honorifics is kept rather than erased', () => {
  assert.equal(normalizeName('Late Shri'), 'LATE SHRI');
  assert.equal(normalizeName('SHRI'), 'SHRI');
});

test('sortNameTokens makes word order irrelevant', () => {
  assert.equal(sortNameTokens('RAM KUMAR SHARMA'), 'KUMAR RAM SHARMA');
  assert.equal(
    sortNameTokens(normalizeName('Sharma Ram Kumar')),
    sortNameTokens(normalizeName('Shri Ram Kumar Sharma')),
  );
});

test('deriveNameForms returns all three forms consistently', () => {
  assert.deepEqual(deriveNameForms('  Shri  Ram   Kumar Sharma '), {
    employeeName: 'Shri Ram Kumar Sharma',
    nameNormalized: 'RAM KUMAR SHARMA',
    nameSorted: 'KUMAR RAM SHARMA',
  });
});
