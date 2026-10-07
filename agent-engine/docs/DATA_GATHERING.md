# Data gathering

Every agent run is also a data collection run. The engine logs each decision it makes, and the
dataset builder turns those logs (plus examples generated from them and from the knowledge base)
into the Laya fine-tuning set. Campaigns ([CAMPAIGN.md](CAMPAIGN.md)) exist mainly to keep this
going unattended.

```
agent run (any mode)
  └─ logs/agent/<run-id>/steps.jsonl        one record per tick decision: state, options, answers, action, verified outcome
campaign (rotates agent runs)
  └─ logs/campaign/<id>/{campaign.log, NNN-<activity>.log, summary.jsonl}
dataset:build (every 4 activities in a campaign, and at the end of microbot-campaign)
  └─ data/dataset/{train,eval}.jsonl + mix-stats.json
```

## What gets logged

### Step log (`logs/agent/<run-id>/steps.jsonl`)

Written by `JsonlStepLogger` (`src/engine/log.ts`). One `StepRecord` per step:

| Field | What |
|---|---|
| `runId`, `step`, `time`, `tick` | identity; the run id is the start time (`2026-10-07T05-35-30-595Z`) |
| `subgoal` | the planner's sub-goal text the decision served |
| `engine`, `model` | `jev` / `laya` and the model that answered |
| `source` | `model` (Jev/Laya picked), `escalation` (LLM overrode a low-confidence pick), `reflex` (eat, flee, level-up dialog), `gate` (busy: walking, animating, in combat), `rule` (deterministic choice) |
| `state` | the compact decision state the model saw (`src/engine/state.ts`): sub-goal, location, status, hp, run, inventory, equipped, relevant skills, recent actions, game messages, prayer |
| `questions` | the `/v1/systemone` questions, each with its option list (`criteria`: option id -> label) |
| `answers` | the model's answers, with the full probability distribution |
| `chosen`, `escalation` | the option taken and (if any) the escalator's correction |
| `action`, `act` | the `/act` payload and whether the client accepted it |
| `outcome` | the verified effect from the next snapshots (`src/engine/verify.ts`): success, effect text, ticks, game messages |
| `latencyMs` | decision and total latency |

Option ids address exact entities: NPCs by client index, objects/ground items by id + tile,
inventory by slot (`inv:2#Bury`). Labels are KB-enriched ("Copper rocks (Mining 1, gives Copper
ore) - 4 tiles").

### Side files (state the strategies keep, also useful for analysis)

| File | Written by | What |
|---|---|---|
| `data/gold-ledger.jsonl` | gold strategy / flows | one line per gold phase: route, outcome, minutes, coin change (carried + last seen banked) |
| `data/rescues.jsonl` | `--rescue` | each LLM rescue (trigger, reason, situation, proposal, `rescuer` = `provider:model`) and its outcome |
| `data/strategy-failures.json` | strategies | failed phases; two failures in 12 h skip the phase |
| `data/bank-seen.json` | engine | last bank contents seen (strategies plan with it) |
| `data/unusable-sites.json` | engine | sites found unusable live (unreachable, wrong area) |
| `data/cache/ge-prices.json` | prereq / gold | OSRS Wiki real-time prices, cached 6 h |
| `logs/campaign/<id>/summary.jsonl` | campaign | one line per activity: name, status, minutes, sub-goals, steps |

`data/` and `logs/` are gitignored. They are the only copy of the collected data; back them up
(e.g. `tar -czf data/dataset/<date>/step-logs.tar.gz logs/agent`) before deleting anything.

## Building the dataset

```bash
npm run dataset:build     # all sources -> data/dataset/{train,eval}.jsonl + mix-stats.json
npm run dataset:export    # only logged decisions -> data/dataset/decisions.jsonl   (--include-done adds "done" answers)
npm run dataset:reverse   # only reverse-generated -> data/dataset/reverse.jsonl  (--per-state 3 --per-pattern 60 --seed 1)
npm run dataset:synth     # only rule-labelled    -> data/dataset/synthetic.jsonl (--per-family 600 --seed 7)
```

`dataset:build` takes `--logs logs/agent --kb data/kb.sqlite --out data/dataset`. A second
character's checkout has its own `logs/agent`; build from it with
`npm run dataset:build -- --logs ~/projects/Microbot_-char2/agent-engine/logs/agent --out /tmp/char2-ds`,
or merge the step log directories first (run ids are timestamps, so they rarely collide).

### Sources

| Source | File | How the label is made | Teaches |
|---|---|---|---|
| `model` | `src/dataset/export.ts` | Jev's own answer, kept only when the action's effect was verified in the next snapshot; soft targets = Jev's distribution. Escalations that succeeded are kept with the LLM's choice as a hard label | real play |
| `reverse` | `src/dataset/reverse.ts` | take a logged state, pick one of its ~16 options, write the sub-goal that would call for it; equivalent options (another cow, banker vs booth) share the soft label | reading the goal; actions never chosen live |
| `synthetic` | `src/dataset/synth.ts` | computed from the KB: weakest/strongest monster, best resource for a level, product -> resource, tool for a resource, best food, most valuable drop, best usable weapon/bow, station for a process | OSRS knowledge |

Filters in `export.ts`:

- only `source: model` and `source: escalation` records;
- **Laya's own decisions are dropped** (`engine: laya`): no self-training on the student;
- actions whose verified outcome failed are dropped;
- stray attacks (attacking a monster the sub-goal never mentions) are dropped.

### Split

`build.ts` holds out whole runs for eval (sha1 of the run id, ~10%), so no state appears in both
splits, plus every 10th synthetic example.

### Size and growth

| Date | Total | Model (train) | Notes |
|---|---|---|---|
| 2026-09-30 | 14,159 -> 16,434 | 2,124 -> 2,947 | first overnight campaign |
| 2026-10-01 | 20,544 | 4,963 | quest sessions; Laya v1 was trained on this |
| 2026-10-05 | 24,688 | 6,575 | after the Jev/Laya A/B |
| 2026-10-07 | 30,169 | 10,810 | `cat data/dataset/mix-stats.json` |

Requests average ~590 tokens (p99 ~750 at 3.5 chars/token); see the token budget in
[LAYA_FINETUNING.md](LAYA_FINETUNING.md). Truncate `game_messages`/`recent_actions` first if a
state grows.

## Coverage: what to gather next

The model rows are skewed toward what campaigns ran most. Check coverage by sub-goal keyword:

```bash
python3 - <<'EOF'
import json, collections
c = collections.Counter()
for l in open('data/dataset/train.jsonl'):
    d = json.loads(l)
    if d['source'] != 'model': continue
    s = d['subgoal'].lower()
    k = next((k for k in ['mine','chop','fish','cook','bank','attack','kill','cast','smelt','smith','tan','herb','clean','mix','string','buy','sell','quest','talk','craft','fletch','burn','pickpocket','runecraft'] if k in s), 'other')
    c[k] += 1
t = sum(c.values())
for k, n in c.most_common(): print(f'{k:12} {n:6} {n/t:6.1%}')
EOF
```

On 2026-10-06 mining was 30%, woodcutting 17%, banking 9.5%, fishing 8.5%, melee 8.4%,
magic ~6.6%; cooking, crafting, firemaking, fletching, thieving, runecrafting, ranged, shops/GE
and quest dialogue were under 4% each. `data/campaign/thin-areas-2026-10-06.json` is the campaign
that targets those gaps (see [CAMPAIGN.md](CAMPAIGN.md#campaign-configs-in-use)).

Rules of thumb:

- Scripted activities (`--task`, scripted gold routes, flows) give many cheap, clean Jev decisions.
- `--goal` activities and quests cover rare situations but need an LLM planner and fail more.
- Reverse examples grow automatically with every new state, so variety of *places and situations*
  matters more than hours on one loop.
- Laya runs (`--engine laya`) produce no training rows. Use them for evaluation only.

## Reading results

```bash
npm run agent -- monitor                          # running campaign: activity, rescues, gold, alerts
tail -f logs/campaign/$(ls logs/campaign | tail -1)/campaign.log
cat data/dataset/mix-stats.json
jq -s 'group_by(.status) | map({status: .[0].status, n: length})' logs/campaign/<id>/summary.jsonl
npm run agent -- llm-report --account <name>      # LLM use and rescue success (plan runs)
```
