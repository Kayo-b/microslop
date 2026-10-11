# Goal plans

A plan file names the build an account should reach. The compiler turns it, plus the live account,
into a roadmap of milestones. A plan run executes the roadmap one milestone at a time with scripts
and Jev/Laya, and calls a cheap LLM only when something is not scripted or a script gets stuck.

```bash
npm run agent -- plan show plans/example-combat-90s.json --offline [--f2p]   # roadmap for a fresh account
npm run agent -- plan show plans/example-combat-90s.json                     # roadmap for the logged-in account
npm run agent -- run --plan plans/example-combat-90s.json                    # run it
npm run campaign -- --plan plans/example-combat-90s.json --hours 6 --restart-client
npm run agent -- llm-report --plan plans/example-combat-90s.json             # LLM use and what to script next
```

## Plan file

```json
{
  "name": "combat-90s",
  "account": "main",
  "targets": { "Attack": 90, "Strength": 90, "Defence": 90, "Ranged": 90, "Magic": 90, "Slayer": 70 },
  "quests": [],
  "items": [],
  "policy": { "boosterQuests": true, "levelsPerPhase": 10, "llm": { "tier1PerHour": 20, "tier2PerHour": 4 } }
}
```

| Field | Meaning |
|---|---|
| `account` | state directory `data/accounts/<account>/` (default: `name`) |
| `targets` | skill -> level |
| `quests`, `items` | extra goals besides what the targets need |
| `policy.boosterQuests` | do quests whose XP rewards skip early brackets (Waterfall, Fight Arena...) |
| `policy.levelsPerPhase` | levels per phase before re-evaluating, which keeps combat stats balanced |
| `policy.llm` | hourly call budgets per LLM tier |

## How the roadmap is built (`src/goalplan/compiler.ts`)

The compiler simulates the account and greedily picks the next milestone:

1. Tutorial Island, while varp 281 is below 1000.
2. Booster quests, while the skills they boost are under 40.
3. Plan quests that can be done now.
4. The target skill furthest behind (level / target), up to `levelsPerPhase` levels, using the
   best `TRAINING` method (by `xpHour`) whose requirements can be met. Unmet requirements become
   milestones first: quests (`QUESTS.req`), items (`ACQUIRE`, with coins from `MONEY` when short),
   other skills, quest points and combat level.

The first milestone is always runnable now. The executor (`StrategyPlanner`, goal kind `plan`)
recompiles after every phase, so a crash, restart or failed phase just resumes from the real
account. Phases that fail twice in 12 hours are skipped (`strategy-failures.json`), and the
compiler then falls through to the next viable method.

`plan show` prints each milestone's **coverage**, i.e. how it runs:

| Coverage | Runs with |
|---|---|
| `scripted` | presets, generic combat, kits, tutorial, item purchase: no LLM |
| `quest-helper+llm` | Quest Helper's current step turned into sub-goals by tier 1 |
| `llm` | a catalog method with no script yet; tier 1 plans each sub-goal |

The hours split by coverage is the to-do list: scripting an `llm` method removes those calls for
good. Goals the catalog cannot reach are listed as blocked.

## LLM tiers (`src/llm/tiered.ts`)

| Tier | Default model | Used for |
|---|---|---|
| 1 | `claude-haiku-4-5` (`LLM_TIER1_MODEL`) | quest steps, `llm` phases, the first rescue for a problem |
| 2 | `claude-sonnet-5-5` (`LLM_TIER2_MODEL`, `CLAUDE_MODEL`) | loops, a rescue reason seen before, tier 1 giving up |

The defaults apply with the Anthropic provider when no model is given. `--llm P` / `--llm-model M`
use one client for both tiers. Over budget, a call returns a refusal: the phase is skipped or the
rescue declined. Every call is logged to `data/accounts/<account>/llm-calls.jsonl` (prompt, answer,
latency), which serves both `llm-report` and a later distill into a local model.

## Account state

`data/accounts/<account>/` (gitignored with the rest of `data/`):

| File | What |
|---|---|
| `bank-seen.json` | last bank contents seen |
| `strategy-failures.json` | failed phases (skipped for 12 h after two failures) |
| `ledger.jsonl` | one line per finished phase: minutes, XP, outcome. The compiler uses observed XP/h over the catalog estimate |
| `rescues.jsonl` | LLM rescues and their outcomes |
| `llm-calls.jsonl` | every LLM call |

## Tutorial Island (`src/goalplan/TutorialPlanner.ts`)

The planner is driven by varp 281. Each call re-reads it and sends the one action the stage needs
through `/act`: talk, `tab_open`, `widget_click`, use item, attack, `cast_on`. Dialogue is clicked
through, and the Ironman offer is declined. After 25 attempts at one stage it gives up to the
rescue, with the stage in the reason.

The stage values follow the commonly documented sequence and are **not verified live yet**. To
capture them on a throwaway account:

1. Watch `./microbot-cli varp 281` while playing through.
2. Fix `TUTORIAL_STAGES` wherever a value or target name differs.

Display name entry at the start is not automated.

## Known gaps

- Ranged and Magic past the starter kits, ammonite crabs, High Alchemy and Slayer are `llm`
  methods. Slayer needs its own module: task varps 394/395, masters, a task table.
- Ammonite crabs need Bone Voyage, whose chain (The Dig Site: Agility, Herblore, Thieving) has no
  training methods in the catalog, so it is blocked. Ranged above 70 is therefore unreachable.
- Ranged/magic kits only know a shortbow with bronze/iron arrows and Wind Strike; gear tiers past
  that are not bought automatically.
- GE buying (`ge_buy`) is not verified live; `ACQUIRE` items all use it for now.
