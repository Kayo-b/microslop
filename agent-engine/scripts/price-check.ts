/** Where is an item worth more? node scripts/price-check.ts "Harralander potion (unf)" ["Other item" ...] */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sellValue } from '../src/goalplan/sellValue.ts';

const names = process.argv.slice(2);
if (!names.length) {
  console.log('usage: node scripts/price-check.ts "Item name" ...');
  process.exit(2);
}
const prices = (JSON.parse(readFileSync('data/cache/ge-prices.json', 'utf8')) as { prices: Record<string, number> }).prices;
const db = new DatabaseSync('data/kb.sqlite', { readOnly: true });
console.log(`${'item'.padEnd(30)} ${'guide'.padStart(8)} ${'GE net'.padStart(8)} ${'shop'.padStart(7)} ${'alch'.padStart(7)}  best`);
for (const name of names) {
  const guide = prices[name.toLowerCase()] ?? null;
  const row = db.prepare('SELECT cost FROM items WHERE name = ? COLLATE NOCASE AND noted = 0 AND cost IS NOT NULL LIMIT 1').get(name) as { cost: number } | undefined;
  const v = sellValue(guide, row?.cost ?? null);
  const f = (n: number | null) => (n === null ? '?' : String(n)).padStart(8);
  console.log(`${name.padEnd(30)} ${f(guide)} ${f(v.ge)} ${f(v.shop).slice(1)} ${f(v.alch).slice(1)}  ${v.best}`);
}
console.log('\nGE net = 70% quick-sell offer minus 2% tax; shop = 40% of store value; alch = 60% (Magic 55 + a nature rune).');
