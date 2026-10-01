/**
 * LLM-backed System 2: an adaptive planner (next sub-goal when one ends), a rescuer (one sub-goal
 * when a scripted planner gives up or gets stuck) and an escalator (picks an option when the
 * System 1 model is unsure). All are called rarely - on sub-goal boundaries, rescues and
 * low-confidence ticks - never every tick.
 *
 * Backend: any provider from providers.ts (Anthropic, OpenAI-compatible APIs, or Claude Code via
 * `claude -p`), chosen by --llm / LLM_PROVIDER or the API key present. Every reply is validated
 * against a zod schema.
 */
import { z } from 'zod';
import type { Escalator, EscalationRequest, EscalationResponse } from '../engine/GameIntentEngine.ts';
import { foldInventory } from '../engine/state.ts';
import { compile, describe, type DoneCondition } from '../planner/conditions.ts';
import type { PlannedSubGoal, Planner, PlannerContext, PlanStep } from '../planner/types.ts';
import { createLlmClient, DEFAULT_ANTHROPIC_MODEL, type LlmClient } from './providers.ts';
import type { RescueRequest, Rescuer } from './rescue.ts';

export const DEFAULT_CLAUDE_MODEL = DEFAULT_ANTHROPIC_MODEL;

export interface LlmOptions {
  /** Backend; default: the one configured in the environment (see providers.ts). */
  llm?: LlmClient;
  effort?: 'low' | 'medium' | 'high';
}

function resolveLlm(opts: LlmOptions): LlmClient {
  const llm = opts.llm ?? createLlmClient();
  if (!llm) throw new Error('No LLM configured: set LLM_PROVIDER (anthropic, claude-code, openai, openrouter, ...) or an API key such as ANTHROPIC_API_KEY / OPENAI_API_KEY');
  return llm;
}

// ---------------------------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------------------------

const PLANNER_SYSTEM = `You plan Old School RuneScape gameplay for an automated agent, one sub-goal at a time.

Each sub-goal you write is executed by a fast classifier that sees the player's state and a short list of concrete options (nearby NPCs/objects with their menu actions, inventory items, open dialogue or bank buttons, and walk destinations) and picks one option per game tick. It is good at matching a clear sub-goal to those options and bad at planning, so:

- Make each sub-goal one concrete activity at one place, completable in roughly 1-400 actions: "chop oak trees until the inventory is full", "walk to the nearest bank and open it", "deposit all oak logs", "talk to the Cook in Lumbridge Castle kitchen".
- Put the exact in-game names the classifier should look for in "targets" (e.g. "Oak tree", "Bank booth", "Banker", "Cook") and the menu actions in "actions" (e.g. "Chop down", "Bank", "Talk-to"). Use real OSRS names.
- List tools and supplies that must never be dropped or deposited (axe, pickaxe, net, bait, food) in "keep_items".
- Set "destination_name" to a place name (town, bank, area) when the player must travel; the agent resolves it with a map database. Leave it null when the targets are already nearby.
- Always give a deterministic "done_when" condition when one exists (inventory full, has/lacks an item, bank open, skill level, near a point). Only leave every field null when completion can only be judged by looking.
- Items no shop nearby sells can be bought at the Grand Exchange (north-west Varrock): one sub-goal "buy N <item> at the Grand Exchange" with targets ["Grand Exchange Clerk", "<item>"], action "Exchange", done_when has_item <item> with the count. It costs the guide price +30%, so carry enough coins.
- Use the reports of previous sub-goals: if one was blocked, change approach (different place, get the missing tool, open a door or gate first) rather than repeating it.
- Answer "complete" when the overall goal is achieved and "impossible" when it cannot be achieved from here without human help (missing membership, quest requirement, money you cannot obtain).
- Keep the account safe: avoid the Wilderness and monsters far above the player's combat level unless the goal requires them.`;

const DoneWhenSchema = z.object({
  inventory_full: z.boolean().nullable(),
  has_item: z.object({ name: z.string(), count: z.number().int() }).nullable(),
  lacks_item: z.string().nullable(),
  bank_open: z.boolean().nullable(),
  skill_level: z.object({ skill: z.string(), level: z.number().int() }).nullable(),
  near: z.object({ x: z.number().int(), y: z.number().int(), plane: z.number().int(), radius: z.number().int() }).nullable(),
});

const PlanSchema = z.object({
  status: z.enum(['continue', 'complete', 'impossible']),
  reasoning: z.string(),
  subgoal: z
    .object({
      text: z.string(),
      targets: z.array(z.string()),
      actions: z.array(z.string()),
      destination_name: z.string().nullable(),
      keep_items: z.array(z.string()),
      done_when: DoneWhenSchema,
      max_steps: z.number().int(),
    })
    .nullable(),
});

type Plan = z.infer<typeof PlanSchema>;

export function toDoneCondition(d: z.infer<typeof DoneWhenSchema>): DoneCondition {
  const c: DoneCondition = {};
  if (d.inventory_full !== null) c.inventoryFull = d.inventory_full;
  if (d.has_item) c.hasItem = { name: d.has_item.name, count: d.has_item.count };
  if (d.lacks_item) c.lacksItem = d.lacks_item;
  if (d.bank_open !== null) c.bankOpen = d.bank_open;
  if (d.skill_level) c.skillLevel = d.skill_level;
  if (d.near) c.near = d.near;
  return c;
}

export function planToStep(plan: Plan): PlanStep {
  if (plan.status === 'complete') return { kind: 'complete', reason: plan.reasoning };
  if (plan.status === 'impossible' || !plan.subgoal) return { kind: 'impossible', reason: plan.reasoning };
  const sg = plan.subgoal;
  const doneWhen = toDoneCondition(sg.done_when);
  const subgoal: PlannedSubGoal = {
    text: sg.text,
    targets: sg.targets,
    actions: sg.actions,
    destination: sg.destination_name ? { name: sg.destination_name } : undefined,
    keep: sg.keep_items,
    doneWhen,
    isDone: compile(doneWhen),
    maxSteps: Math.min(Math.max(sg.max_steps, 5), 600),
    // The count to buy/withdraw (shop, bank and Grand Exchange options size themselves on it).
    want: doneWhen?.hasItem ? [{ name: doneWhen.hasItem.name, count: doneWhen.hasItem.count ?? 1 }] : undefined,
  };
  return { kind: 'subgoal', subgoal };
}

export function plannerPrompt(ctx: PlannerContext): string {
  const s = ctx.snapshot;
  const pos = s.player?.position;
  const kb = ctx.kb;
  const lines: string[] = [`Overall goal: ${ctx.goal}`, ''];
  if (pos) {
    const area = kb?.labelsNear(pos, 60, 2).map((p) => p.name).join(', ');
    lines.push(`Position: (${pos.x}, ${pos.y}, floor ${pos.plane})${area ? ` near ${area}` : ''}`);
    const banks = kb?.nearestBanks(pos, 2).map((b) => `${b.name} (${b.distance} tiles)`).join(', ');
    if (banks) lines.push(`Nearest banks: ${banks}`);
  }
  if (s.player) {
    lines.push(`HP ${s.player.hp.current}/${s.player.hp.max}, combat level ${s.player.combatLevel}, run ${s.player.runEnergy}%`);
  }
  lines.push(`Skills: ${s.skills.map((k) => `${k.name} ${k.level}`).join(', ')}`);
  lines.push(`Inventory: ${foldInventory(s)}`);
  lines.push(`Equipped: ${s.equipment.map((e) => e.name).join(', ') || 'nothing'}`);
  const nearby = [...new Set([...s.npcs.map((n) => n.name), ...s.objects.map((o) => o.name)])].slice(0, 25);
  lines.push(`Nearby: ${nearby.join(', ') || 'nothing interactable'}`);
  if (s.bank.open) lines.push(`Bank is open (${s.bank.items.length} item stacks visible)`);
  if (s.dialogue.inDialogue) lines.push(`Dialogue open: ${[s.dialogue.text, ...s.dialogue.options].filter(Boolean).join(' | ')}`);
  lines.push('');
  if (ctx.reports.length === 0) {
    lines.push('No sub-goals attempted yet.');
  } else {
    lines.push('Previous sub-goals (oldest first):');
    for (const r of ctx.reports.slice(-6)) {
      lines.push(`- "${r.subgoal}" -> ${r.result} after ${r.steps} steps: ${r.reason}`);
      for (const t of r.trail.slice(-3)) lines.push(`    ${t}`);
    }
  }
  lines.push('', 'Decide the next sub-goal.');
  return lines.join('\n');
}

export class LlmPlanner implements Planner {
  readonly name: string;
  private readonly llm: LlmClient;
  private readonly effort: 'low' | 'medium' | 'high';

  constructor(opts: LlmOptions = {}) {
    this.llm = resolveLlm(opts);
    this.effort = opts.effort ?? 'medium';
    this.name = `llm:${this.llm.name}`;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    const res = await this.llm.structured({ system: PLANNER_SYSTEM, user: plannerPrompt(ctx), schema: PlanSchema, schemaName: 'plan', effort: this.effort });
    if (res.kind === 'refusal') return { kind: 'impossible', reason: `planner request declined: ${res.reason}` };
    return planToStep(res.value);
  }
}

/** @deprecated name kept for existing callers; the planner works with any configured LLM. */
export const ClaudePlanner = LlmPlanner;

// ---------------------------------------------------------------------------------------------
// Escalator
// ---------------------------------------------------------------------------------------------

const ESCALATOR_SYSTEM = `You are the fallback decider for an Old School RuneScape agent. A fast classifier was unsure which action to take this game tick. You get the current sub-goal, a compact player state, and the exact option lists the classifier saw. Choose the single best next step:

- "interact" with one option id from the action options,
- "walk" with one option id from the destinations,
- "wait" when the current activity is still in progress,
- "done" when the sub-goal is already complete.

Only use option ids that appear in the lists. Prefer options without missing requirements. Keep "note" to one short sentence explaining the choice.`;

const EscalationSchema = z.object({
  op: z.enum(['interact', 'walk', 'wait', 'done']),
  option_id: z.string().nullable(),
  note: z.string(),
});

export function escalationPrompt(req: EscalationRequest): string {
  const lines = [
    `Sub-goal: ${req.goal.text}`,
    `Why you are asked: ${req.reason}`,
    req.modelChoice ? `Classifier's tentative choice: ${req.modelChoice.op} ${req.modelChoice.optionId ?? ''} (confidence ${req.modelChoice.confidence.toFixed(2)})` : '',
    '',
    `State: ${JSON.stringify(req.state)}`,
    '',
    'Action options:',
    ...req.candidates.map((c) => `- ${c.id}: ${c.label}`),
    '',
    'Destinations:',
    ...(req.destinations.length ? req.destinations.map((d) => `- ${d.id}: ${d.label}`) : ['- (none)']),
  ];
  return lines.filter((l) => l !== undefined).join('\n');
}

export class LlmEscalator implements Escalator {
  private readonly llm: LlmClient;
  private readonly effort: 'low' | 'medium' | 'high';

  constructor(opts: LlmOptions = {}) {
    this.llm = resolveLlm(opts);
    // Low effort: this sits on the tick path and only has to pick from a short list.
    this.effort = opts.effort ?? 'low';
  }

  async choose(req: EscalationRequest): Promise<EscalationResponse | null> {
    const res = await this.llm.structured({ system: ESCALATOR_SYSTEM, user: escalationPrompt(req), schema: EscalationSchema, schemaName: 'escalation', effort: this.effort, maxTokens: 4000 });
    if (res.kind === 'refusal') return null;
    const out = res.value;
    return { op: out.op, optionId: out.option_id ?? undefined, note: out.note };
  }
}

/** @deprecated see LlmEscalator. */
export const ClaudeEscalator = LlmEscalator;

/** For logs and the CLI: one line describing a planned sub-goal. */
export function describeSubGoal(sg: PlannedSubGoal): string {
  const parts = [sg.text];
  if (sg.targets?.length) parts.push(`targets: ${sg.targets.join(', ')}`);
  if (sg.destination?.name) parts.push(`destination: ${sg.destination.name}`);
  parts.push(`done when: ${describe(sg.doneWhen)}`);
  return parts.join(' | ');
}


// ---------------------------------------------------------------------------------------------
// Rescuer
// ---------------------------------------------------------------------------------------------

const RESCUE_SYSTEM = `${PLANNER_SYSTEM}

You are being called as a rescue: a scripted planner normally drives this agent, and it just gave up or got stuck. Propose ONE sub-goal that gets past the specific problem (go around an obstacle, use a different target or place, fetch a missing item, close or answer an interface), after which the scripted planner resumes. Do not re-plan the whole goal. Answer "impossible" only when no sub-goal can help without a human.`;

/** Asks the configured LLM for one sub-goal that gets past what the scripted planner could not handle. */
export class LlmRescuer implements Rescuer {
  readonly name: string;
  private readonly llm: LlmClient;

  constructor(opts: LlmOptions = {}) {
    this.llm = resolveLlm(opts);
    this.name = this.llm.name;
  }

  async rescue(ctx: PlannerContext, req: RescueRequest): Promise<PlanStep> {
    const user =
      req.trigger === 'loop'
        ? [
            plannerPrompt(ctx),
            '',
            `LOOP DETECTED: ${req.reason.replace(/^loop: /, '')}.`,
            ...(req.evidence ?? []),
            '',
            'The agent has been going in circles across several sub-goals. Work out what is actually happening (a locked door or trapdoor that needs a key or another route first, a quest step done out of order, a one-way door, an item that must be obtained elsewhere, a wrong place). Look up the quest or location if you can. Then propose ONE sub-goal that does something different and breaks the loop, or answer "impossible" if this goal cannot progress from here and should be abandoned.',
          ].join('\n')
        : [plannerPrompt(ctx), '', `RESCUE (${req.trigger}): the scripted "${req.planner}" planner reports: ${req.reason}`, 'Propose one sub-goal that gets past this.'].join('\n');
    const res = await this.llm.structured({ system: RESCUE_SYSTEM, user, schema: PlanSchema, schemaName: 'plan', effort: req.trigger === 'loop' ? 'high' : 'medium' });
    if (res.kind === 'refusal') return { kind: 'impossible', reason: `rescue request declined: ${res.reason}` };
    return planToStep(res.value);
  }
}

/** @deprecated see LlmRescuer. */
export const ClaudeRescuer = LlmRescuer;
