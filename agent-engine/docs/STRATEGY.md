# Strategies, quests and LLM rescue

## Layers

```
strategy   (level | money | quest)  picks a phase from the catalog + live account profile
  phase    scripted planner (preset / generic combat) | LLM planner | quest runner
    sub-goal   planner output, run by the engine
      tick     reflexes -> gates -> Jev/Laya picks one option -> /act -> verify
watchdog   ends sub-goals that stop making progress
rescue     Claude proposes one sub-goal when a planner gives up or the watchdog trips
```

## Commands

```bash
npm run agent -- strategy                          # dry run: account, next phase per strategy, catalog status
npm run agent -- run --strategy level              # raise the lowest trainable skill, bracket by bracket
npm run agent -- run --strategy level --skill Fishing --level 40
npm run agent -- run --strategy money              # best available money route, re-evaluated every 30 min
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
