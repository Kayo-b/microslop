# Lessons from live runs

What went wrong in real runs and what changed in the agent. Add a row when a run teaches something;
prefer a rule in code (planner, engine, catalog) over a hint in a prompt.

| Run | What happened | Change |
|---|---|---|
| Quest run (char 2) | Dropped 13 unfinished potions to free space | `Drop` only for worthless items (`src/engine/drops.ts`); gather presets bank; prompt forbids dropping; quests start by banking materials |
| Imp Catcher (char 2) | Ground imps for 40 min though the step said the beads can be bought and 6M coins were banked | `QuestPlanner` tells the LLM to buy when the step says so and coins are on hand |
| Craft-jewellery rescue (char 1, free) | "Varrock gold mine" resolved to Karamja Volcano; the free character walked towards Brimhaven | free accounts get no walk destination outside the free-to-play map (`src/strategy/f2p.ts`) |
| Hunter plan (char 2) | Route to Feldip Hills stalled in the walker | not fixed yet (walker/pathfinder) |
| Runecraft (char 2) | LLM tried to buy essence at Aubury's shop (not sold): opened and closed the shop 12 times; then walked to the Body ruins instead of the planned Air ruins (generic "Mysterious ruins" = nearest); ~30 min of boats from Land's End | scripted `RunecraftPlanner` (GE essence + talisman, ruins id/tile from the KB, direct `Enter`/`Craft-rune`/`Portal` actions); coordinates in a sub-goal's text beat the nearest same-named object; prompt says shops do not sell essence |
| Furnace (char 2) | `blocked: no options` three times, no LLM rescue | `blocked` rescue trigger after two blocked sub-goals in a row |

Pattern: when an LLM-driven method repeats the same mistake, script it. `npm run agent -- llm-report`
and `data/rescues.jsonl` list what keeps needing rescue.
