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
import { ClaudeEscalator, ClaudePlanner, describeSubGoal } from './llm/claude.ts';
import { compile, type DoneCondition } from './planner/conditions.ts';
import { COMBAT_PRESETS, PRESETS, SingleSubGoalPlanner, TaskTreePlanner } from './planner/TaskTreePlanner.ts';
import { SmithingPlanner } from './planner/SmithingPlanner.ts';
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
  npm run agent -- run --subgoal TEXT [--targets A,B] [--actions X,Y] [--keep A,B]
                       [--done-lacks ITEM | --done-has ITEM[:COUNT] | --done-full | --done-near X,Y,PLANE]
                       [--dest PLACE | --dest-at X,Y,PLANE] [--max-steps N]

Flags: --engine jev|laya  --min-confidence N  --max-subgoals N  --log-dir DIR  --kb FILE`);
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

async function run(): Promise<void> {
  const kb = openKb();
  const backend = new MicrobotBackend();
  let planner: Planner;
  let goal: string;
  if (values.task === 'smith-progression') {
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
  } else if (values.goal) {
    planner = new ClaudePlanner();
    goal = values.goal;
  } else {
    throw new Error('run needs --task PRESET, --subgoal TEXT or --goal TEXT');
  }

  const logger = new JsonlStepLogger(values['log-dir']);
  const engine = new GameIntentEngine({
    backend,
    decisionEngine: createDecisionEngine(values.engine),
    kb,
    escalator: values.escalate ? new ClaudeEscalator() : null,
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
    console.log(`${'smith-progression'.padEnd(18)} mine, smelt and smith bronze then iron gear around Lumbridge, equipping upgrades (--metal, --until-level)`);
  }
  else if (command === 'inspect') await inspect();
  else if (command === 'run') await run();
  else {
    help();
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`[agent] ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
}
