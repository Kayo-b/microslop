# Strategies, quests and LLM rescue

## Layers

```
strategy   (level | money | gold | quest)  picks a phase from the catalog + live account profile
  phase    scripted planner (preset / generic combat) | LLM planner | quest runner
    sub-goal   planner output, run by the engine
      tick     reflexes -> gates -> Jev/Laya picks one option -> /act -> verify
watchdog   ends sub-goals that stop making progress
rescue     Claude proposes one sub-goal when a planner gives up or the watchdog trips
```

For a whole build (target levels, quests, items) run from a fresh account, see
[PLANS.md](PLANS.md): plan files compile into a roadmap of these phases.

## Commands

```bash
npm run agent -- strategy                          # dry run: account, next phase per strategy, catalog status
npm run agent -- run --strategy level              # raise the lowest trainable skill, bracket by bracket
npm run agent -- run --strategy level --skill Fishing --level 40
npm run agent -- run --strategy money              # best available money route, re-evaluated every 30 min
npm run agent -- run --strategy gold               # rotate through every gold route that fits (below)
npm run agent -- run --strategy quest              # next unfinished quest in the recommended order
npm run agent -- run --strategy quest --quest "Cook's Assistant"
npm run agent -- run --task kill-barbarians --rescue   # any run: add Claude rescue
```

`--rescue`, `llm` phases and quests need `ANTHROPIC_API_KEY` in the repo-root `.env`. Without it,
those phases are skipped and the strategy moves to the next scripted one.

## Data sources

| What | Source |
|---|---|
| Membership | varp 1780 (membership days) via `/varp` |
| Quest points | varp 101 |
| Quest states (274 quests) | Quest Helper via `/quest-helper/states` |
| Quest walkthrough steps | Quest Helper current step via `/quest-helper/status` |
| Levels, inventory, equipment | `/snapshot` |
| Bank contents | last bank seen, persisted in `data/bank-seen.json` |
| Monster spawns, banks | KB (`data/kb.sqlite`, from cache + wiki) |
| Methods, money routes, quest order | `src/strategy/catalog.ts` (curated) |

The catalog is curated game knowledge: training brackets, F2P/P2P money routes with rough gp/h,
and a recommended quest order with requirements and rewards. Its gp/h numbers are for ranking only;
prices move, so a live price feed (prices.runescape.wiki) is the next step for money routes.

## Gold strategy

`--strategy gold` makes coins by alternating between routes (`GOLD` in `catalog.ts`: the money
routes plus looting, coin drops, pickpocketing, wool and amulet stringing) instead of always taking the
best estimate, so the data covers many ways of earning and the ledger shows which ones pay.

- Each run first sells banked products and `JUNK` on the Grand Exchange (at most once an hour).
- Gear is smithed, never bought: coins only go into making more coins. Until Smithing 48 and a
  steel platebody, every other turn is a `gold:gear` phase (`smith-progression`: mine, smelt and
  smith bronze, then iron from Smithing 15, then steel from 35, wearing each piece it unlocks and
  smithing daggers for XP in between; those are sold as junk).
- Then the fitting route that ran least recently goes next (untried first, best estimate first),
  for 25 minutes. Two failures in 12 h drop a route (`data/strategy-failures.json`).
- Every phase is appended to `data/gold-ledger.jsonl` with its outcome, minutes and coin change
  (carried + last seen banked). The ledger also carries the rotation across runs.

Scripted trading loops (coins in, more coins out; live GE prices from the OSRS Wiki API):

- `tan-hides` (`TanningPlanner`, also `--task tan-hides`): buy up to 270 cowhides at the GE within
  the carried coins (500 kept back), bank the notes at Al Kharid, withdraw 27, trade Ellis and
  "Tan All" (1 gp a hide), bank the leather; once the hides are gone, sell the leather as notes.
  ~95 gp a hide at 2026-10 prices; gives up when the margin or the coins run out.
- `string-amulets` (`StringingPlanner`, also `--task string-amulets`): at the GE, string the F2P
  amulet with the best margin after the 2% tax (emerald, ~55 gp, on 2026-10-06) with balls of
  wool, 14 per inventory; gives up when no amulet clears 20 gp.

**Rules for fighting routes** (moss giants, hill giants, guards, and any route added later):

1. Give the route `recommend` levels (comfortable, not just allowed) and a `food` count on its
   `combat` execution. Below the recommended levels, the route's turn becomes a levelling phase
   (`gold:<route>:train`): the skill furthest below its target, trained with the melee method for
   that skill's own level bracket, up to the bracket's top or the target. Its next turns keep
   levelling until the fight itself runs.
2. Every fight, including the levelling phases, goes through the prerequisite flow
   ([PREREQUISITES.md](PREREQUISITES.md)): weapon, head, body, legs and shield of the best tier
   the levels allow, and the route's food (default 5) are owned, bought or cooked before the fight
   starts. Do not add a fight that skips it (`--no-prereq`).

## Execution kinds

- `preset`: an existing scripted planner (gathering, combat, cooking, smithing).
- `combat`: a generic fight/loot/bank loop against any monster; area from the catalog or the
  nearest non-Wilderness KB spawn.
- `llm`: the Claude planner with a method description. These are the methods not scripted yet.
- `quest`: Quest Helper selects the quest and supplies the current step; Claude turns it into sub-goals.

## Rescue log

`data/rescues.jsonl` holds one `rescue` record per LLM call (trigger, reason, situation, proposal)
and one `outcome` record when that sub-goal ends. Rescues that keep recurring are the list of
deterministic rules still to write; each one scripted is an LLM call that stops happening.
