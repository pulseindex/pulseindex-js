// Generates the fixture both SDKs assert against. Run it only when the
// tokenizer deliberately changes, and bump Text.TOKENIZER_VERSION when you do.
import { writeFileSync } from 'node:fs';
import { Text } from '../dist/index.js';

const CASES = [
  'Müller',                    // the fold that makes or breaks a German directory
  'Zahnarzt',
  'Dr. Anna-Lena Schröder',    // punctuation, hyphen, and a title
  'ß',                         // the sharp s, which folds to two letters
  'ab',                        // shorter than MIN_PREFIX, so no prefix tags
  'abc',                       // exactly MIN_PREFIX
  'Gastroenterologe',          // longer than MAX_PREFIX
  'İstanbul Üsküdar',          // a dotted capital I, which lowercases oddly
  '  spaced   out  ',
  'O’Brien',                   // a typographic apostrophe
  // Every script, since the first version dropped anything outside a-z:
  'Yıldız Çelik',              // Turkish dotless i, which NFKD does not decompose
  'Søren Łódź Đorđe Æsir',     // more letters with no decomposition
  'محمد العتيبي',              // Arabic
  'مُحَمَّد',                   // Arabic with diacritics: the same name as above
  'أحمد إسلام آمنة',           // alef with hamza and madda
  'مدرسة مصطفى',               // ta marbuta and alef maqsura
  'ΟΔΟΣ Αθηνών',               // Greek, with a final sigma
  'Москва Йошкар-Ола',         // Cyrillic
  '٢٠٢٤ ۱۴۰۳',                 // Arabic-Indic and Persian digits
  '東京タワー',                 // CJK: no spaces, no alphabet to misspell in
];

const out = CASES.map((input) => ({
  input,
  normalized: Text.normalize(input),
  terms: Text.terms(input),
  termTag: Text.termTag(input),
  prefixTag: Text.prefixTag(input),
  indexTokens: Text.indexTokens(input).sort(),
  spellingCount: Text.spellingTags(input).length,
}));

writeFileSync(new URL('../tests/text-token-vectors.json', import.meta.url),
              JSON.stringify(out, null, 2) + '\n');
console.log('wrote %d vectors', out.length);
