/** Prints the training catalog: node scripts/training-list.ts [Skill] [f2p|p2p] */
import { TRAINING } from '../src/strategy/catalog.ts';

const args = process.argv.slice(2);
const mode = args.find((a) => a === 'f2p' || a === 'p2p');
const skill = args.find((a) => a !== 'f2p' && a !== 'p2p');
const rows = TRAINING.filter((m) => (!skill || m.skill.toLowerCase() === skill.toLowerCase()) && (mode !== 'f2p' || !m.members));
if (!rows.length) {
  console.log(`no training methods for ${skill ?? 'that filter'}`);
  process.exit(0);
}
let last = '';
for (const m of rows) {
  if (m.skill !== last) console.log(`\n${m.skill}`);
  last = m.skill;
  const how = m.exec.kind === 'llm' ? 'llm' : m.exec.kind === 'quest' ? 'quest' : 'script';
  console.log(`  ${String(m.from).padStart(2)}-${String(m.to).padEnd(3)} ${m.members ? 'P2P' : 'F2P'} ${how.padEnd(6)} ${m.name}`);
}
console.log('\nscript = fully scripted, llm = Claude plans + Jev/Laya clicks, quest = Quest Helper');
