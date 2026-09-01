// Every var(--x) referenced anywhere must be defined somewhere as `--x:`.
//
// This is a lint, not a test, on purpose: an undefined custom property does not
// throw and does not render as "nothing" — the browser falls back to the
// inherited value, which is a perfectly plausible intentional colour. A runtime
// assertion would have to restate the whole design to spot it; a grep just
// sees the typo.
import { readFileSync } from 'node:fs';

const defined = new Set();
const used = new Map();

for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) defined.add(m[1]);
  for (const m of src.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) used.set(m[1], file);
}

const missing = [...used].filter(([name]) => !defined.has(name));
console.log(`defined ${defined.size} custom properties, referenced ${used.size}`);
for (const [name, file] of missing) console.log(`  UNDEFINED ${name}  (referenced in ${file})`);
process.exit(missing.length ? 1 : 0);
