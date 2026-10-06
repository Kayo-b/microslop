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
import { freshProfile, roadmap } from './goalplan/compiler.ts';
import { monitorReport, readMonitorInput } from './campaign/monitor.ts';
import { chooseOption, FlowPlanner, FLOWS, flowStatus } from './flows/FlowPlanner.ts';
import { loadGePrices } from './prereq/prices.ts';
import { accountPaths, appendLedger, type LedgerRecord, observedRates, readJsonl } from './goalplan/ledger.ts';
import { llmReport } from './goalplan/report.ts';
import { accountDir, loadPlan, type PlanSpec } from './goalplan/spec.ts';
import { TutorialPlanner } from './goalplan/TutorialPlanner.ts';
import { createTiers, GuardedLlm, HourlyBudget, jsonlCallLog, type LlmCallRecord, type LlmPurpose, TieredRescuer } from './llm/tiered.ts';
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
import { JsonlRescueLog, type Rescuer, type RescueOutcomeRecord, type RescueRecord, RescuingPlanner } from './llm/rescue.ts';
import { BankMemory, buildProfile, level, readAccount, unmet } from './strategy/account.ts';
import { MONEY, QUESTS, TRAINING } from './strategy/catalog.ts';
import { QuestPlanner } from './strategy/QuestPlanner.ts';
import { choosePhase, GOLD_MAX_BLOCKED, StrategyPlanner, type StrategyGoal } from './strategy/StrategyPlanner.ts';
import { recentFailures, recordFailure } from './strategy/skips.ts';
import { compile, type DoneCondition } from './planner/conditions.ts';
import { COMBAT_PRESETS, PRESETS, SingleSubGoalPlanner, TaskTreePlanner } from './planner/TaskTreePlanner.ts';
import { SmithingPlanner } from './planner/SmithingPlanner.ts';
import { StringingPlanner } from './goalplan/StringingPlanner.ts';
import { TanningPlanner } from './goalplan/TanningPlanner.ts';
import { COOK_PRESETS, CookingPlanner } from './planner/CookingPlanner.ts';
import type { Planner } from './planner/types.ts';
import { activityNeeds, catalogReqFor } from './prereq/needs.ts';
import { counts as prereqCounts, PrereqPlanner } from './prereq/PrereqPlanner.ts';
import { resolveSetup } from './prereq/resolve.ts';
import type { Execution } from './strategy/catalog.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    task: { type: 'string' },
    goal: { type: 'string' },
    since: { type: 'string' },
    flow: { type: 'string' },
    option: { type: 'string' },
    hours: { type: 'string' },
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
    plan: { type: 'string' },
    account: { type: 'string' },
    offline: { type: 'boolean', default: false },
    f2p: { type: 'boolean', default: false },
    llm: { type: 'string' },
    'llm-model': { type: 'string' },
    'rescue-model': { type: 'string' },
    skill: { type: 'string' },
    level: { type: 'string' },
    quest: { type: 'string' },
    decide: { type: 'boolean', default: false },
    'min-confidence': { type: 'string' },
    'max-subgoals': { type: 'string' },
    'log-dir': { type: 'string', default: path.join(ROOT, 'logs', 'agent') },
    kb: { type: 'string', default: path.join(ROOT, 'data', 'kb.sqlite') },
    'no-prereq': { type: 'boolean', default: false },
    'setup-budget': { type: 'string' },
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
  npm run agent -- run --strategy level [--skill S] [--level N] | money | gold | quest [--quest NAME]
  npm run agent -- plan show FILE [--offline [--f2p]]                 (roadmap, estimates, LLM coverage)
  npm run agent -- run --plan FILE                                    (run a plan; LLM rescue on when a key is set)
  npm run agent -- prereq --task PRESET [--setup-budget N]            (dry run: what the activity needs first)
  npm run agent -- llm-report (--plan FILE | --account NAME)          (LLM use, rescue success, what to script next)
  npm run agent -- flow [gold]                                          (a flow's option tree and the sub-flows each option needs)
  npm run agent -- run --flow gold [--option ID]                      (strict: one option and only its own sub-flows)
  npm run agent -- monitor [--since ISO | --hours N]                  (running campaign: activity, rescues by model, gold, alerts)
  npm run agent -- run --subgoal TEXT [--targets A,B] [--actions X,Y] [--keep A,B]
                       [--done-lacks ITEM | --done-has ITEM[:COUNT] | --done-full | --done-near X,Y,PLANE]
                       [--dest PLACE | --dest-at X,Y,PLANE] [--max-steps N]

Flags: --no-prereq  skip the prerequisites flow (tools, gear, food, coins, levels) before a run
       --engine jev|laya  --min-confidence N  --max-subgoals N  --log-dir DIR  --kb FILE
       --rescue   let an LLM propose a sub-goal when a scripted planner gives up or gets stuck
                  (rescues logged to data/rescues.jsonl)
       --llm P    LLM backend: anthropic | claude-code | openai | openrouter | groq | together |
                  gemini | deepseek | mistral | xai | ollama | lmstudio (or LLM_PROVIDER; default:
                  the provider whose API key is set)   --llm-model M   model for that backend`);
}

async function prereqShow(): Promise<void> {
  if (!values.task) throw new Error('prereq needs --task PRESET');
  const kb = openKb();
  const backend = new MicrobotBackend();
  const snap = await backend.snapshot();
  const bank = new BankMemory();
  const needs = activityNeeds({ kind: 'preset', preset: values.task, bank: values.bank }, catalogReqFor({ kind: 'preset', preset: values.task, bank: values.bank }));
  if (!needs) {
    console.log(`${values.task}: nothing to check`);
    return;
  }
  const profile = buildProfile(await readAccount(backend), snap, bank);
  const pos = snap.player?.position;
  const shop = (item: string) => {
    const o = pos && kb ? kb.shopOffers(item, pos)[0] : undefined;
    return o ? { source: { kind: 'shop' as const, name: o.shop, keeper: o.keeper, point: o.point }, price: o.price } : null;
  };
  const gePrice = await loadGePrices(path.join(ROOT, 'data', 'cache', 'ge-prices.json'));
  const setup = resolveSetup(needs, { profile, counts: prereqCounts(snap, bank) }, { skip: recentFailures(path.join(ROOT, 'data', 'strategy-failures.json')), shop, gePrice });
  const budget = values['setup-budget'] ? Number(values['setup-budget']) : 30;
  console.log(`${needs.name}: bank last seen ${bank.seenAt ?? 'never'}, ${profile.coins} coins`);
  console.log(`needs: ${JSON.stringify({ req: needs.req, tools: needs.tools.map((t) => t.any), supplies: needs.supplies.map((x) => x.item), food: needs.food, gear: needs.gear, kit: needs.style, inputs: needs.inputs.map((i) => i.item) })}`);
  if (setup.blocked.length) console.log(`blocked: ${setup.blocked.join('; ')}`);
  setup.steps.forEach((st, i) => console.log(`${String(i + 1).padStart(2)}. ~${String(st.minutes).padStart(3)} min  ${st.phase.text}  (${st.why})`));
  console.log(setup.steps.length ? `total ~${setup.minutes} min: ${setup.minutes > budget ? `over the ${budget}-min budget, the activity would be skipped` : 'runs before the activity'}` : 'prerequisites met');
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
  if (kind === 'gold') return { kind, lastRun: goldLastRun() };
  throw new Error(`unknown strategy "${kind}" (level | money | gold | quest)`);
}

const GOLD_LEDGER = path.join(ROOT, 'data', 'gold-ledger.jsonl');

/** When each gold route last started, from the ledger, so the rotation continues across runs. */
function goldLastRun(): Map<string, number> {
  const last = new Map<string, number>();
  for (const r of readJsonl<LedgerRecord>(GOLD_LEDGER)) {
    const started = Date.parse(r.ts) - r.minutes * 60_000;
    // gold:<route> or gold:<route>:train (a fight's levelling turn counts as the route's turn).
    const id = r.phase.split(':')[1] ?? r.phase;
    if (started > (last.get(id) ?? 0)) last.set(id, started);
  }
  return last;
}

/** The LLM backend chosen by --llm/--llm-model or the environment; null when none is configured. */
let llmClient: LlmClient | null | undefined;
function llm(): LlmClient | null {
  if (llmClient === undefined) llmClient = createLlmClient({ provider: values.llm, model: values['llm-model'] });
  return llmClient;
}
const hasLlm = () => llm() !== null;

/** Dry run: a flow's option tree on the logged-in account, with the sub-flows each option triggers. */
async function flowShow(): Promise<void> {
  const id = positionals[1] ?? values.flow ?? 'gold';
  const flow = FLOWS[id];
  if (!flow) throw new Error(`unknown flow "${id}" (${Object.keys(FLOWS).join(', ')})`);
  const backend = new MicrobotBackend();
  const snap = await backend.snapshot();
  const bank = new BankMemory();
  const account = await readAccount(backend);
  const gePrice = await loadGePrices(path.join(ROOT, 'data', 'cache', 'ge-prices.json'));
  const skip = recentFailures(path.join(ROOT, 'data', 'strategy-failures.json'));
  const status = flowStatus(flow, { profile: buildProfile(account, snap, bank), counts: prereqCounts(snap, bank) }, { members: account.members, skip, gePrice });
  const best = chooseOption(status, skip);
  console.log(`${flow.name} (bank last seen ${bank.seenAt ?? 'never'}); a goal run would take: ${best?.id ?? 'nothing'}`);
  for (const { option, setup } of status.sort((a, b) => b.option.perHour - a.option.perHour)) {
    const state = setup.blocked.length ? `blocked: ${setup.blocked.join('; ')}` : setup.steps.length ? `sub-flows first (~${setup.minutes} min)` : 'ready';
    console.log(`\n${option.id.padEnd(18)} ~${String(Math.round(option.perHour / 1000)).padStart(3)}k/h  ${state}${skip.has(option.phase.id) ? ' [skipped: failed twice in 12 h]' : ''}`);
    for (const st of setup.steps) console.log(`  -> ${st.phase.text} (~${st.minutes} min; ${st.why})`);
  }
}

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

function planPaths(spec: PlanSpec) {
  return accountPaths(path.join(ROOT, accountDir(spec)));
}

/** Dry run of a plan: the compiled roadmap for the live account (or a fresh one with --offline). Never acts. */
async function planShow(): Promise<void> {
  const file = positionals[1] === 'show' ? positionals[2] : (positionals[1] ?? values.plan);
  if (!file) throw new Error('plan show needs a plan file: npm run agent -- plan show plans/NAME.json');
  const spec = loadPlan(file);
  const paths = planPaths(spec);
  let profile;
  if (values.offline) {
    profile = freshProfile(!values.f2p);
  } else {
    const backend = new MicrobotBackend();
    profile = buildProfile(await readAccount(backend), await backend.snapshot(), new BankMemory(paths.bank));
  }
  const skip = recentFailures(paths.failures);
  const r = roadmap(spec, profile, { skip, rates: observedRates(readJsonl<LedgerRecord>(paths.ledger)) });
  console.log(`Plan "${spec.name}" for ${values.offline ? `a fresh ${values.f2p ? 'F2P' : 'members'} account` : 'the logged-in account'} (state: ${paths.dir})`);
  if (skip.size) console.log(`Skipping phases that failed twice in the last 12 h: ${[...skip].join(', ')}`);
  let total = 0;
  r.milestones.forEach((m, i) => {
    total += m.hours;
    console.log(`${String(i + 1).padStart(3)}. ${m.coverage.padEnd(16)} ${m.hours.toFixed(1).padStart(5)} h  ${total.toFixed(0).padStart(4)} h  ${m.text}  (${m.why})`);
  });
  const by = new Map<string, number>();
  for (const m of r.milestones) by.set(m.coverage, (by.get(m.coverage) ?? 0) + m.hours);
  console.log(`\nEstimated ${r.hours.toFixed(0)} h: ${[...by].map(([c, h]) => `${c} ${Math.round((100 * h) / (r.hours || 1))}%`).join(', ')}`);
  console.log(r.complete ? 'The roadmap reaches every goal.' : `Not reachable with the current catalog: ${r.blocked.join(', ') || 'milestone limit hit'}`);
}

function report(): void {
  const dir = values.plan ? path.join(ROOT, accountDir(loadPlan(values.plan))) : values.account ? path.join(ROOT, 'data', 'accounts', values.account) : null;
  if (!dir) throw new Error('llm-report needs --plan FILE or --account NAME');
  const paths = accountPaths(dir);
  const lines = llmReport(readJsonl<LlmCallRecord>(paths.llmCalls), readJsonl<RescueRecord | RescueOutcomeRecord>(paths.rescues), readJsonl<LedgerRecord>(paths.ledger));
  console.log(`Account state: ${dir}\n${lines.join('\n')}`);
}

async function run(): Promise<void> {
  const kb = openKb();
  const backend = new MicrobotBackend();
  // Prerequisites flow (src/prereq/): an activity's tools, gear, food, coins and levels are met
  // before it starts; setups longer than --setup-budget minutes (default 30) skip the activity.
  const withPrereq = (exec: Execution, inner: Planner, o: { bank?: BankMemory; skip?: Set<string>; onFailed?: (id: string) => void } = {}): Planner => {
    if (values['no-prereq']) return inner;
    const needs = activityNeeds(exec, catalogReqFor(exec));
    if (!needs) return inner;
    return new PrereqPlanner(inner, needs, {
      account: backend,
      kb,
      gePrice: () => loadGePrices(path.join(ROOT, 'data', 'cache', 'ge-prices.json')),
      bank: o.bank,
      skip: o.skip,
      budgetMinutes: values['setup-budget'] ? Number(values['setup-budget']) : 30,
      log: (m) => console.log(m),
      onSetupFailed: o.onFailed,
    });
  };
  const skipFile = path.join(ROOT, 'data', 'strategy-failures.json');
  let planner: Planner;
  let goal: string;
  let strategyFailed: ((phaseId: string) => void) | undefined;
  // Kept apart from `planner`: --rescue wraps it.
  let strategy: StrategyPlanner | null = null;
  // Plan runs: tiered rescue (on whenever an LLM is configured) logged to the account's directory.
  let planRescue: { rescuer: Rescuer; log: string } | null = null;
  if (values.task && COOK_PRESETS[values.task]) {
    planner = new CookingPlanner(COOK_PRESETS[values.task]!, values.task);
    goal = `${values.task} on fires until the bank has none left`;
  } else if (values.task === 'tan-hides') {
    const bank = new BankMemory();
    const gePrice = await loadGePrices(path.join(ROOT, 'data', 'cache', 'ge-prices.json'));
    planner = new TanningPlanner({ bank: () => (bank.seenAt ? bank.items : null), price: gePrice });
    goal = 'buy cowhides, tan them at Ellis in Al Kharid and sell the leather';
  } else if (values.task === 'string-amulets') {
    planner = new StringingPlanner({ price: await loadGePrices(path.join(ROOT, 'data', 'cache', 'ge-prices.json')) });
    goal = 'string amulets with wool at the Grand Exchange and sell them';
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
  } else if (values.plan) {
    const spec = loadPlan(values.plan);
    const paths = planPaths(spec);
    const failing = recentFailures(paths.failures);
    if (failing.size) console.log(`[plan] skipping phases that failed twice in the last 12 h: ${[...failing].join(', ')}`);
    strategyFailed = (id) => recordFailure(paths.failures, id);
    const tiers = createTiers({ provider: values.llm, model: values['llm-model'] });
    const callLog = jsonlCallLog(paths.llmCalls);
    const budgets = { 1: new HourlyBudget(spec.policy.llm.tier1PerHour), 2: new HourlyBudget(spec.policy.llm.tier2PerHour) };
    const guarded = (tier: 1 | 2, purpose: LlmPurpose) => new GuardedLlm(tier === 1 ? tiers!.tier1 : tiers!.tier2, { tier, purpose, budget: budgets[tier], log: callLog });
    console.log(`[plan] ${spec.name}: state in ${paths.dir}; LLM ${tiers ? `tier 1 ${tiers.tier1.name}, tier 2 ${tiers.tier2.name}` : 'none (llm and quest phases are skipped)'}`);
    const planBank = new BankMemory(paths.bank);
    planner = strategy = new StrategyPlanner(
      { kind: 'plan', spec, rates: observedRates(readJsonl<LedgerRecord>(paths.ledger)) },
      {
        skip: failing,
        account: backend,
        kb,
        bank: planBank,
        prereq: (phase, inner) => withPrereq(phase.exec, inner, { bank: planBank, skip: failing, onFailed: (id) => recordFailure(paths.failures, id) }),
        llmPlanner: () => (tiers ? new LlmPlanner({ llm: guarded(1, 'plan') }) : null),
        questPlanner: (q) => (tiers ? new QuestPlanner(q, backend, new LlmPlanner({ llm: guarded(1, 'quest') })) : null),
        tutorialPlanner: () => new TutorialPlanner(backend),
        onPhase: (phase, why) => {
          console.log(`[plan] ${phase.text} [${phase.exec.kind}]: ${why}`);
          if (why.startsWith('gave up')) strategyFailed?.(phase.id);
        },
        onPhaseEnd: (phase, end) => {
          console.log(`[plan] phase ended (${end.outcome}, ${end.minutes.toFixed(0)} min): ${phase.text}`);
          appendLedger(paths.ledger, { ts: new Date().toISOString(), plan: spec.name, phase: phase.id, text: phase.text, skill: phase.until?.skill, ...end });
        },
      },
    );
    if (tiers) planRescue = { rescuer: new TieredRescuer(new LlmRescuer({ llm: guarded(1, 'rescue') }), new LlmRescuer({ llm: guarded(2, 'rescue') })), log: paths.rescues };
    goal = `plan ${spec.name}`;
  } else if (values.strategy) {
    const g = strategyGoal(values.strategy);
    const failing = recentFailures(skipFile);
    if (failing.size) console.log(`[strategy] skipping phases that failed twice in the last 12 h: ${[...failing].join(', ')}`);
    strategyFailed = (id) => recordFailure(skipFile, id);
    const gePrice = await loadGePrices(path.join(ROOT, 'data', 'cache', 'ge-prices.json'));
    planner = strategy = new StrategyPlanner(g, {
      skip: failing,
      account: backend,
      kb,
      gePrice,
      prereq: (phase, inner) => withPrereq(phase.exec, inner, { skip: failing, onFailed: (id) => recordFailure(skipFile, id) }),
      llmPlanner: () => (hasLlm() ? new LlmPlanner({ llm: llm()! }) : null),
      questPlanner: (q) => (hasLlm() ? new QuestPlanner(q, backend, new LlmPlanner({ llm: llm()! })) : null),
      onPhase: (phase, why) => {
        console.log(`[strategy] ${phase.text} [${phase.exec.kind}]: ${why}`);
        if (why.startsWith('gave up')) strategyFailed?.(phase.id);
      },
      onPhaseEnd: (phase, end) => {
        console.log(`[strategy] phase ended (${end.outcome}, ${end.minutes.toFixed(0)} min, ${end.coins >= 0 ? '+' : ''}${end.coins} coins): ${phase.text}`);
        if (g.kind === 'gold') appendLedger(GOLD_LEDGER, { ts: new Date().toISOString(), plan: 'gold', phase: phase.id, text: phase.text, ...end });
      },
    });
    goal = `strategy ${values.strategy}${values.skill ? ` ${values.skill}` : ''}${values.level ? ` to ${values.level}` : ''}${values.quest ? ` ${values.quest}` : ''}`;
  } else if (values.flow) {
    const flow = FLOWS[values.flow];
    if (!flow) throw new Error(`unknown flow "${values.flow}" (${Object.keys(FLOWS).join(', ')})`);
    const failing = recentFailures(skipFile);
    const gePrice = await loadGePrices(path.join(ROOT, 'data', 'cache', 'ge-prices.json'));
    const bank = new BankMemory();
    const strategyDeps = {
      account: backend,
      kb,
      bank,
      gePrice,
      llmPlanner: () => (hasLlm() ? new LlmPlanner({ llm: llm()! }) : null),
      questPlanner: (q: string) => (hasLlm() ? new QuestPlanner(q, backend, new LlmPlanner({ llm: llm()! })) : null),
    };
    planner = new FlowPlanner(flow, values.option, {
      view: async (ctx) => ({ profile: buildProfile(await readAccount(backend), ctx.snapshot, bank), counts: prereqCounts(ctx.snapshot, bank) }),
      members: async () => (await readAccount(backend)).members,
      strategy: strategyDeps,
      prereq: { account: backend, kb, bank, skip: failing, gePrice: async () => gePrice, strategy: strategyDeps, log: (m) => console.log(m), onSetupFailed: (id) => recordFailure(skipFile, id) },
      skip: failing,
      log: (m) => console.log(m),
    });
    goal = `flow ${flow.name}${values.option ? `: ${values.option}` : ''}`;
  } else if (values.goal) {
    if (!hasLlm()) throw new Error('--goal needs an LLM: --llm PROVIDER or LLM_PROVIDER / an API key (see docs/STRATEGY.md)');
    planner = new LlmPlanner({ llm: llm()! });
    goal = values.goal;
  } else {
    throw new Error('run needs --task PRESET, --subgoal TEXT or --goal TEXT');
  }

  if (values.task) {
    planner = withPrereq({ kind: 'preset', preset: values.task, bank: values.bank }, planner, { skip: recentFailures(skipFile), onFailed: (id) => recordFailure(skipFile, id) });
  }

  // A quest selected by an earlier run (or by hand) keeps Quest Helper's QuestScript walking
  // and clicking next to the agent; quest phases re-select theirs with autoplay off.
  await backend.questHelperStop().catch(() => undefined);

  if (planRescue) {
    const log = new JsonlRescueLog(planRescue.log);
    planner = new RescuingPlanner(planner, planRescue.rescuer, log);
    console.log(`[agent] tiered LLM rescue on (${planRescue.rescuer.name}); rescues logged to ${log.file}`);
  } else if (values.rescue) {
    if (!hasLlm()) throw new Error('--rescue needs an LLM: --llm PROVIDER or LLM_PROVIDER / an API key (see docs/STRATEGY.md)');
    const log = new JsonlRescueLog();
    // Rescues can run on their own (cheaper, faster) model while planning keeps --llm-model.
    const rescueLlm = values['rescue-model'] ? createLlmClient({ provider: values.llm, model: values['rescue-model'] })! : llm()!;
    planner = new RescuingPlanner(planner, new LlmRescuer({ llm: rescueLlm }), log);
    console.log(`[agent] LLM rescue on (${rescueLlm.name}); rescues logged to ${log.file}`);
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
    // Gold gives up a stuck route itself and moves on; the run-wide limit then only ends runs
    // where the next routes fail as well.
    maxBlockedInARow: values.strategy === 'gold' ? 3 * GOLD_MAX_BLOCKED : undefined,
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
  // The run itself gave up mid-phase (sub-goals kept failing): count it against that phase.
  const phase = strategy?.phase ?? null;
  if (phase && (outcome.status === 'impossible' || outcome.status === 'halted')) strategyFailed?.(phase.id);
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
  else if (command === 'plan') await planShow();
  else if (command === 'prereq') await prereqShow();
  else if (command === 'llm-report') report();
  else if (command === 'flow') await flowShow();
  else if (command === 'monitor') {
    const since = values.since ? Date.parse(values.since) : values.hours ? Date.now() - Number(values.hours) * 3_600_000 : undefined;
    console.log(monitorReport(readMonitorInput(ROOT, { since })).join('\n'));
  }
  else {
    help();
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`[agent] ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
}
