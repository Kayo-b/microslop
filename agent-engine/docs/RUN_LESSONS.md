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
| Runecraft (char 2, scripted) | Level 1 picked the level-2 mind altar; the plain `Enter` click did nothing, the user had to use the talisman on the ruins by hand | Air altar added for level 1; the planner uses the talisman on the ruins (`use_item_on`) |
| Jewellery (char 1) | `use_item_on` bar -> furnace opened the jewellery interface (group 446), which the snapshot did not report, so the bar was used again every 2 s; separately a recipe picked before the bank was seen stayed null ('no recipe pays' with 800k banked) | snapshot/`production_select` support the jewellery interface; recipe re-picked while null; Agent ends the same direct action sent 8 times with nothing changing |
| Runecraft (char 2, watcher: stuck in the altar) | Inside the mind altar with Runecraft 1 and a mind talisman bought by an earlier run: the altar was 17 tiles away (beyond the snapshot's object radius), the planner waited for it forever, then the game said "need a Runecrafting level of at least 2" | the room the player stands in decides; altar and portal clicked by KB id and tile (walking included); a room the level cannot use is left by its portal |
| Jev down (char 2) | `api.typesafe.ai` returned 503 and timeouts for minutes: every sub-goal ended blocked | `fallbackEscalator`: with an LLM configured, Claude picks when the decision engine is unreachable |
| Coins (char 2) | Walked to the altar with 6.6M in the bag: one death loses it all | trading planners withdraw a capped budget (`coinTopUp`: 60k essence, 300-500k others) and bank the rest before walking; a generic coin guard in `PrereqPlanner` banks anything above 60k down to 25k between sub-goals (not for trading loops, which manage their own); presets without tool needs now get the loadout and guard too |
| Jewellery bank loop (char 1, watcher) | Carrying 26 gold bars but not the recipe's (necklace) mould: bars counted as "something to bank", the bank branch had nothing to do and closed, and the planner reopened it every 4 s for 30+ rounds | inputs and the mould in the bag no longer force a bank visit; a carried trip with no mould goes to buy one; the Agent's repeated-action counter restarts after a sub-goal |
| Rescue missed the bank loop | The Haiku rescue only counted blocked reports in a row; the loop alternated done (open the bank) and blocked (close it), so it never fired in 30+ rounds | `blocked` rescue also fires on 3 blocked among the last 6 reports |
| Runecraft ended impossible (char 2, dashboard) | Walking the last 5 tiles to the ruins, the walk sub-goal was complete the instant it started and was re-issued 20 times: "planner keeps re-issuing a sub-goal that is already complete" ended the job, and nothing restarted it for hours | the planner waits while still moving near the ruins; `make-gold dash` shows an idle campaign at a glance |

Pattern: when an LLM-driven method repeats the same mistake, script it. `npm run agent -- llm-report`
and `data/rescues.jsonl` list what keeps needing rescue.

## The run watcher

`src/campaign/watcher.ts` (started by `gold-run start`, so by every `make-gold` / `make-level` job; `NO_WATCH=1`
skips it) asks Haiku (`WATCH_MODEL`, default `claude-haiku-4-5-20251001`; `claude-sonnet-5-5` reviews more carefully) every `WATCH_INTERVAL` seconds (180) whether the run is
healthy, from the last 30 agent steps, the campaign log, the live snapshot and recent rescues. Output: the journal of
`watch-char1|2`, `data/watch/reviews.jsonl` (with the evidence) and a desktop notification at severity 2+. It can act, within limits (below). `make-agent watch-last CHAR=2` shows the latest reviews; read `reviews.jsonl` when planning the next fixes.

### What the watcher may do

Each review also picks an action. Only `stuck`/`wrong` at severity 2+ act (`WATCH_ACT=0` or `--no-act` turns acting off):
`close_interfaces` (bank, shop, Grand Exchange windows) and `cancel_walk` run at once; `skip_activity` (SIGTERM to this
checkout's `agent run`, so the campaign starts the next activity with a fresh planner) needs the same problem in two
reviews in a row and at most one skip per 8 minutes. A run with no new steps for ~9 minutes is skipped without waiting.
What it did is in `reviews.jsonl` (`acted`) and the journal. Fixes that need code stay as suggestions.

### Watcher and rescue work together

The watcher writes each review to `data/watch/latest.json`. The rescue (Haiku, `--rescue-model`) reads it between
sub-goals: a stuck/wrong verdict at severity 2+, newer than the run's start and under 8 minutes old, triggers a
`watcher` rescue straight away, with the review's diagnosis and suggested fix in the prompt. So the first stuck
verdict goes to the rescue; the watcher's own actions come later: soft ones (close windows, cancel the walk) when the
next review still says stuck, ending the activity at the third.

## Boat trips from the LLM (Port Sarim -> Hosidius sand crabs)
Char 2 sailed to Land's End, then the model chose `wait` instead of crossing the gangplank (`obj:50065 #Cross`) and
accepted the next sail dialogue: "You pay 2,700 coins and sail to Musa Point", back to where it started, and repeated the
trip. The walker also reported ~1550 tiles to go from the dock. There is no scripted boat handling yet, so Magic now uses the
scripted Wind Strike chicken preset up to level 25 (it was 13) and only then the sand-crab trip. A lone job also sits out one
cooldown round after an error instead of three (the idle minutes after a client timeout).
