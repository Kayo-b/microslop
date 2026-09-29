/**
 * agent-engine CLI.
 *
 *   npm run agent -- presets
 *   npm run agent -- inspect [--decide] [--goal "chop trees"] [--targets "Tree,Oak tree"]
 *   npm run agent -- run --task chop-trees [--bank] [--until-level 15]
 *   npm run agent -- run --goal "get 10 woodcutting near Lumbridge" [--escalate]
 *   npm run agent -- run --subgoal "bury all bones" --targets Bones --actions Bury --done-lacks Bones
 *
 * Common flags: --engine jev|laya (default DECISION_ENGINE or jev), --min-confidence 0.4,
 * --log-dir logs/agent, --kb data/kb.sqlite, --max-subgoals 200.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Agent, type AgentEvent } from './agent/Agent.ts';
import { MicrobotBackend } from './backend/MicrobotBackend.ts';
import { createDecisionEngine } from './decision/adapters.ts';
import type { ChoiceAnswer } from './decision/types.ts';
import { buildCandidates } from './engine/candidates.ts';
import { GameIntentEngine } from './engine/GameIntentEngine.ts';
import { JsonlStepLogger } from './engine/log.ts';
import { buildDecisionState, relevantSkillsFor } from './engine/state.ts';
import { KnowledgeBase } from './kb/KnowledgeBase.ts';
import { describeSubGoal, LlmEscalator, LlmPlanner, LlmRescuer } from './llm/claude.ts';
import { createLlmClient, type LlmClient } from './llm/providers.ts';
import { JsonlRescueLog, RescuingPlanner } from './llm/rescue.ts';
import { BankMemory, buildProfile, level, readAccount, unmet } from './strategy/account.ts';
import { MONEY, QUESTS, TRAINING } from './strategy/catalog.ts';
import { QuestPlanner } from './strategy/QuestPlanner.ts';
import { choosePhase, StrategyPlanner, type StrategyGoal } from './strategy/StrategyPlanner.ts';
import { compile, type DoneCondition } from './planner/conditions.ts';
import { COMBAT_PRESETS, PRESETS, SingleSubGoalPlanner, TaskTreePlanner } from './planner/TaskTreePlanner.ts';
import { SmithingPlanner } from './planner/SmithingPlanner.ts';
import { COOK_PRESETS, CookingPlanner } from './planner/CookingPlanner.ts';
import type { Planner } from './planner/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    task: { type: 'string' },
    goal: { type: 'string' },
    subgoal: { type: 'string' },
    actions: { type: 'string' },
    keep: { type: 'string' },
    'done-lacks': { type: 'string' },
    'done-has': { type: 'string' },
    'done-full': { type: 'boolean', default: false },
    'max-steps': { type: 'string' },
    dest: { type: 'string' },
    'dest-at': { type: 'string' },
    'done-near': { type: 'string' },
    'done-bank-open': { type: 'boolean', default: false },
    'done-bank-closed': { type: 'boolean', default: false },
    'done-shop-open': { type: 'boolean', default: false },
    'make-amount': { type: 'string' },
    'done-equipped': { type: 'string' },
    'done-object-near': { type: 'string' },
    metal: { type: 'string' },
    targets: { type: 'string' },
    bank: { type: 'boolean', default: false },
    'until-level': { type: 'string' },
    engine: { type: 'string' },
    escalate: { type: 'boolean', default: false },
    rescue: { type: 'boolean', default: false },
    strategy: { type: 'string' },
    llm: { type: 'string' },
    'llm-model': { type: 'string' },
    skill: { type: 'string' },
    level: { type: 'string' },
    quest: { type: 'string' },
    decide: { type: 'boolean', default: false },
    'min-confidence': { type: 'string' },
    'max-subgoals': { type: 'string' },
    'log-dir': { type: 'string', default: path.join(ROOT, 'logs', 'agent') },
    kb: { type: 'string', default: path.join(ROOT, 'data', 'kb.sqlite') },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const command = positionals[0] ?? 'help';

function openKb(): KnowledgeBase | null {
  if (!existsSync(values.kb!)) {
    console.warn(`[agent] no knowledge base at ${values.kb} - labels will lack skill/tool hints. Build it with: npm run kb:dump && npm run kb:wiki && npm run kb:build`);
    return null;
  }
  return new KnowledgeBase(values.kb!);
}

function help(): void {
  console.log(`Usage:
  npm run agent -- presets
  npm run agent -- inspect [--decide] [--goal TEXT] [--targets A,B]
  npm run agent -- run --task PRESET [--bank] [--until-level N]
  npm run agent -- run --goal TEXT [--escalate]
  npm run agent -- strategy [--strategy level|money|quest]      (dry run: account profile and next phase)
  npm run agent -- run --strategy level [--skill S] [--level N] | money | quest [--quest NAME]
  npm run agent -- run --subgoal TEXT [--targets A,B] [--actions X,Y] [--keep A,B]
                       [--done-lacks ITEM | --done-has ITEM[:COUNT] | --done-full | --done-near X,Y,PLANE]
                       [--dest PLACE | --dest-at X,Y,PLANE] [--max-steps N]

Flags: --engine jev|laya  --min-confidence N  --max-subgoals N  --log-dir DIR  --kb FILE
       --rescue   let an LLM propose a sub-goal when a scripted planner gives up or gets stuck
                  (rescues logged to data/rescues.jsonl)
       --llm P    LLM backend: anthropic | claude-code | openai | openrouter | groq | together |
                  gemini | deepseek | mistral | xai | ollama | lmstudio (or LLM_PROVIDER; default:
                  the provider whose API key is set)   --llm-model M   model for that backend`);
}

async function inspect(): Promise<void> {
  const kb = openKb();
  const backend = new MicrobotBackend();
  const snap = await backend.snapshot();
  if (!snap.loggedIn) {
    console.log(`Not logged in (gameState ${snap.gameState}).`);
    return;
  }
  const goal = { text: values.goal ?? 'look around', targets: values.targets?.split(',').map((t) => t.trim()) };
  const { candidates, destinations } = buildCandidates(snap, kb, goal);
  const state = buildDecisionState(snap, goal, [], kb, relevantSkillsFor(goal, kb));
  console.log('State:', JSON.stringify(state, null, 2));
  console.log(`\nAction options (${candidates.length}):`);
  for (const c of candidates) console.log(`  ${c.id.padEnd(44)} ${c.label}`);
  console.log(`\nDestinations (${destinations.length}):`);
  for (const d of destinations) console.log(`  ${d.id.padEnd(10)} ${d.label}`);

  if (values.decide) {
    const engine = createDecisionEngine(values.engine);
    const res = await engine.decide({
      state,
      questions: {
        op: { type: 'choice', instructions: 'What should the player do next?', criteria: { interact: 'use one of the options', walk: 'travel to a destination', wait: 'keep waiting', done: 'sub-goal complete' } },
        ...(candidates.length ? { target: { type: 'choice' as const, instructions: `Which action best serves "${goal.text}"?`, criteria: Object.fromEntries(candidates.map((c) => [c.id, c.label])) } } : {}),
        ...(destinations.length ? { destination: { type: 'choice' as const, instructions: 'Where should the player go?', criteria: Object.fromEntries(destinations.map((d) => [d.id, d.label])) } } : {}),
      },
    });
    console.log(`\n${engine.name} (${res.model ?? '?'}, ${res.latencyMs} ms):`);
    for (const a of Object.values(res.answers)) {
      if (a.type === 'choice') console.log(`  ${a.questionId}: ${(a as ChoiceAnswer).choice} (confidence ${a.confidence.toFixed(2)})`);
    }
    console.log('\n(inspect never acts)');
  }
  kb?.close();
}

function strategyGoal(kind: string): StrategyGoal {
  if (kind === 'level') return { kind, skill: values.skill, level: values.level ? Number(values.level) : undefined };
  if (kind === 'money') return { kind };
  if (kind === 'quest') return { kind, quest: values.quest };
  throw new Error(`unknown strategy "${kind}" (level | money | quest)`);
}

/** The LLM backend chosen by --llm/--llm-model or the environment; null when none is configured. */
let llmClient: LlmClient | null | undefined;
function llm(): LlmClient | null {
  if (llmClient === undefined) llmClient = createLlmClient({ provider: values.llm, model: values['llm-model'] });
  return llmClient;
}
const hasLlm = () => llm() !== null;

/** Dry run: the account profile and what each strategy would do next. Never acts. */
async function strategy(): Promise<void> {
  const kb = openKb();
  const backend = new MicrobotBackend();
  const snap = await backend.snapshot();
  const bank = new BankMemory();
  const account = await readAccount(backend);
  const p = buildProfile(account, snap, bank);
  const finished = [...account.quests].filter(([, st]) => st === 'FINISHED').map(([q]) => q);
  console.log(`Account: ${account.members ? 'members' : 'free-to-play'}, ${account.questPoints} quest points, combat ${p.combatLevel}, melee bracket ${level(p, 'Melee')}`);
  console.log(`Quests finished: ${finished.join(', ') || 'none'}`);
  console.log(`Bank: ${p.bankKnown ? `${bank.items.size} stacks (seen ${bank.seenAt})` : 'not seen yet (open it once so item requirements can be checked)'}`);
  console.log(`LLM: ${hasLlm() ? llm()!.name : 'none configured (--llm or LLM_PROVIDER / an API key): llm and quest phases are skipped'}`);
  for (const kind of values.strategy ? [values.strategy] : ['level', 'money', 'quest']) {
    const choice = choosePhase(strategyGoal(kind), p, new Set());
    const text = !choice ? 'nothing fits' : 'done' in choice ? `done: ${choice.done}` : `${choice.phase.text} [${choice.phase.exec.kind}] - ${choice.why}`;
    console.log(`\n${kind.toUpperCase()}: ${text}`);
  }
  const avail = (req: Parameters<typeof unmet>[0], members: boolean) => {
    const miss = [...(members && !account.members ? ['membership'] : []), ...unmet(req, p)];
    return miss.length ? `needs ${miss.join(', ')}` : 'ok';
  };
  console.log('\nTraining methods:');
  for (const m of TRAINING) console.log(`  ${m.skill.padEnd(11)} ${String(m.from).padStart(2)}-${String(m.to).padEnd(2)} ${m.name.padEnd(52)} ${m.exec.kind.padEnd(6)} ${avail(m.req, m.members)}`);
  console.log('\nMoney routes:');
  for (const r of MONEY) console.log(`  ${r.name.padEnd(55)} ~${String(Math.round(r.gpHour / 1000)).padStart(3)}k/h ${r.exec.kind.padEnd(6)} ${avail(r.req, r.members)}`);
  console.log('\nQuests (recommended order):');
  for (const q of QUESTS) console.log(`  ${(account.quests.get(q.name) ?? '?').padEnd(12)} ${q.name.padEnd(26)} ${avail(q.req, q.members).padEnd(24)} ${q.reward}`);
  kb?.close();
}

async function run(): Promise<void> {
  const kb = openKb();
  const backend = new MicrobotBackend();
  let planner: Planner;
  let goal: string;
  if (values.task && COOK_PRESETS[values.task]) {
    planner = new CookingPlanner(COOK_PRESETS[values.task]!, values.task);
    goal = `${values.task} on fires until the bank has none left`;
  } else if (values.task === 'smith-progression') {
    const metal = values.metal === 'bronze' || values.metal === 'iron' ? values.metal : undefined;
    planner = new SmithingPlanner({ untilLevel: values['until-level'] ? Number(values['until-level']) : undefined, metal });
    goal = `smithing progression to level ${values['until-level'] ?? 33}${metal ? ` (${metal})` : ''}`;
  } else if (values.task) {
    planner = TaskTreePlanner.fromPreset(values.task, { bank: values.bank, untilLevel: values['until-level'] ? Number(values['until-level']) : undefined });
    goal = `${values.task}${values.bank ? ' (banking)' : ' (dropping)'}${values['until-level'] ? ` until level ${values['until-level']}` : ''}`;
  } else if (values.subgoal) {
    const list = (v?: string) => v?.split(',').map((x) => x.trim()).filter(Boolean);
    const doneWhen: DoneCondition = {};
    let want: { name: string; count: number }[] | undefined;
    if (values['done-lacks']) {
      const names = list(values['done-lacks'])!;
      if (names.length === 1) doneWhen.lacksItem = names[0];
      else doneWhen.lacksItems = names;
    }
    if (values['done-has']) {
      // "Feather:30" = hold at least 30 feathers. Several: "Copper ore:14,Tin ore:14".
      const specs = list(values['done-has'])!.map((spec) => {
        const [name, count] = spec.split(':');
        return { name: name!.trim(), count: count ? Number(count) : 1 };
      });
      if (specs.length === 1) doneWhen.hasItem = specs[0];
      else doneWhen.hasItems = specs;
      want = specs.map((x) => ({ name: x.name, count: x.count }));
    }
    if (values['done-full']) doneWhen.inventoryFull = true;
    if (values['done-bank-open']) doneWhen.bankOpen = true;
    if (values['done-bank-closed']) doneWhen.bankOpen = false;
    if (values['done-shop-open']) doneWhen.shopOpen = true;
    if (values['done-equipped']) doneWhen.equipped = list(values['done-equipped']);
    if (values['done-object-near']) doneWhen.objectNear = { name: values['done-object-near'], radius: 2 };
    const point = (v?: string) => {
      if (!v) return undefined;
      const [x, y, plane] = v.split(',').map(Number);
      return { x: x!, y: y!, plane: plane ?? 0 };
    };
    const destPoint = point(values['dest-at']);
    const near = point(values['done-near']);
    if (near) doneWhen.near = { ...near, radius: 4 };
    planner = new SingleSubGoalPlanner({
      text: values.subgoal,
      targets: list(values.targets),
      actions: list(values.actions),
      keep: list(values.keep),
      want,
      makeAmount: values['make-amount'] ? (Number(values['make-amount']) as 1 | 5 | 10) : undefined,
      destination: values.dest || destPoint ? { name: values.dest, point: destPoint } : undefined,
      doneWhen,
      isDone: compile(doneWhen),
      maxSteps: values['max-steps'] ? Number(values['max-steps']) : 60,
    });
    goal = values.subgoal;
  } else if (values.strategy) {
    const g = strategyGoal(values.strategy);
    planner = new StrategyPlanner(g, {
      account: backend,
      kb,
      llmPlanner: () => (hasLlm() ? new LlmPlanner({ llm: llm()! }) : null),
      questPlanner: (q) => (hasLlm() ? new QuestPlanner(q, backend, new LlmPlanner({ llm: llm()! })) : null),
      onPhase: (phase, why) => console.log(`[strategy] ${phase.text} [${phase.exec.kind}]: ${why}`),
    });
    goal = `strategy ${values.strategy}${values.skill ? ` ${values.skill}` : ''}${values.level ? ` to ${values.level}` : ''}${values.quest ? ` ${values.quest}` : ''}`;
  } else if (values.goal) {
    if (!hasLlm()) throw new Error('--goal needs an LLM: --llm PROVIDER or LLM_PROVIDER / an API key (see docs/STRATEGY.md)');
    planner = new LlmPlanner({ llm: llm()! });
    goal = values.goal;
  } else {
    throw new Error('run needs --task PRESET, --subgoal TEXT or --goal TEXT');
  }

  if (values.rescue) {
    if (!hasLlm()) throw new Error('--rescue needs an LLM: --llm PROVIDER or LLM_PROVIDER / an API key (see docs/STRATEGY.md)');
    const log = new JsonlRescueLog();
    planner = new RescuingPlanner(planner, new LlmRescuer({ llm: llm()! }), log);
    console.log(`[agent] LLM rescue on (${llm()!.name}); rescues logged to ${log.file}`);
  }
  const logger = new JsonlStepLogger(values['log-dir']);
  const engine = new GameIntentEngine({
    backend,
    decisionEngine: createDecisionEngine(values.engine),
    kb,
    escalator: values.escalate ? new LlmEscalator({ llm: llm() ?? undefined }) : null,
    logger,
    runId: logger.runId,
    minConfidence: values['min-confidence'] ? Number(values['min-confidence']) : undefined,
  });
  const agent = new Agent({
    backend,
    engine,
    planner,
    kb,
    maxSubGoals: values['max-subgoals'] ? Number(values['max-subgoals']) : undefined,
    onEvent: printEvent,
  });

  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log('\n[agent] stopping after the current step (Ctrl+C again to force)...');
    agent.stop();
    backend.act({ op: 'walk_cancel' }).catch(() => {});
  });
  // kill / service stop: a walk started by the agent keeps going in the client otherwise.
  process.on('SIGTERM', () => {
    agent.stop();
    void backend.act({ op: 'walk_cancel' }).catch(() => {}).finally(() => process.exit(143));
  });

  console.log(`[agent] goal: ${goal} | planner: ${planner.name} | log: ${logger.file}`);
  const outcome = await agent.run(goal);
  console.log(`[agent] ${outcome.status}: ${outcome.reason} (${outcome.subgoals} sub-goals, ${outcome.steps} steps)`);
  kb?.close();
  if (outcome.status === 'error') process.exitCode = 1;
}

function printEvent(e: AgentEvent): void {
  const t = new Date().toLocaleTimeString();
  switch (e.type) {
    case 'subgoal':
      console.log(`${t} ▶ ${describeSubGoal(e.subgoal)}`);
      break;
    case 'step': {
      const r = e.result;
      if (r.kind === 'acted') console.log(`${t}   ${r.source.padEnd(10)} ${r.label ?? r.action.op} -> ${r.outcome.effect}`);
      else if (r.kind === 'blocked') console.log(`${t}   blocked: ${r.reason}`);
      break;
    }
    case 'report':
      console.log(`${t} ■ ${e.report.result}: ${e.report.reason} (${e.report.steps} steps)`);
      break;
    case 'stuck':
      console.log(`${t} ⚠ stuck (${e.reason}) -> ${e.recovery}`);
      break;
    case 'wait':
      console.log(`${t} ⏸ ${e.reason}`);
      break;
    case 'finished':
      break;
  }
}

try {
  if (values.help || command === 'help') help();
  else if (command === 'presets') {
    console.log(Object.entries({ ...PRESETS, ...COMBAT_PRESETS }).map(([k, v]) => `${k.padEnd(18)} ${v.activity}`).join('\n'));
    for (const [k, v] of Object.entries(COOK_PRESETS)) console.log(`${k.padEnd(18)} cook ${v.raw.toLowerCase()} on fires (chop, light, cook, bank)`);
    console.log(`${'smith-progression'.padEnd(18)} mine, smelt and smith bronze then iron gear around Lumbridge, equipping upgrades (--metal, --until-level)`);
  }
  else if (command === 'inspect') await inspect();
  else if (command === 'strategy') await strategy();
  else if (command === 'run') await run();
  else {
    help();
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`[agent] ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
}
