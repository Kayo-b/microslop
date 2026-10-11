# Strategies, quests and LLM rescue

## Layers

```
strategy   (level | money | gold | quest)  picks a phase from the catalog + live account profile
  phase    scripted planner (preset / generic combat) | LLM planner | quest runner
    sub-goal   planner output, run by the engine
      tick     reflexes -> gates -> Jev/Laya picks one option -> /act -> verify
watchdog   ends sub-goals that stop making progress
rescue     Claude proposes one sub-goal when a planner gives up, the watchdog trips, or two sub-goals in a row are blocked
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

- `herblore` (`HerblorePlanner`, members, also `--task herblore`): needs Herblore 3 and Druidic
  Ritual. At the GE, picks the best recipe per hour for the level from live prices: clean grimy
  herbs (27 per trip, one click each), clean grimy herbs then mix them with vials of water into
  unfinished potions, or mix bought clean herbs (14 + 14, Make All). On 2026-10-06: marrentill
  cleaning (+188) from level 5, harralander unfinished potions from 22, ranarr from 30; finished
  potions all lost money. Cleaning XP moves the choice up by itself.

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

## Flows (strict option trees)

A flow is a goal with a fixed tree of options; a flow run executes **one option and only the
sub-flows its requirements trigger**. Nothing unrelated runs: no rotation, no money route to earn
missing coins, no setup time cap (levelling Smithing 27 -> 30 for smelting is part of the flow).

```bash
npm run agent -- flow gold                            # the tree for the logged-in account
npm run agent -- run --flow gold --option smelt-steel # strict: this option and its sub-flows
npm run agent -- run --flow gold                      # the best option that can be set up
```

```
make gold
├─ tan-hides       needs coins                          -> ready
├─ smelt-steel     needs Smithing 30, Mining 30         -> train Smithing (smith-progression)
├─ moss-giants     needs combat 40; recommended Atk/Str 40, Def 35 -> train Strength, Defence
└─ ...             (every free-to-play GOLD route)
```

- Options come from the catalog (`GOLD` for `make gold`, `src/flows/FlowPlanner.ts`); an option's
  requirements are its `req` plus its `recommend` levels plus what its execution needs (tools,
  gear, food).
- Sub-flows come from the prerequisite resolver: missing levels become training phases (scripted
  methods first, then a scripted method from a lower bracket, LLM methods last), missing items
  purchases. A coin shortfall blocks the option (`not earned inside this flow`).
- A goal run picks the best option per hour whose sub-flows can be set up, and sticks to it.
- In a campaign: `{ "name": "smelt", "args": ["--flow", "gold", "--option", "smelt-steel"] }`.

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
