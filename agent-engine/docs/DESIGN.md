# Design notes, tests and known limits

- **The classifier only gets real choices.** Waiting, eating, level-up dialogs, and completion
  checks are deterministic. The op question is dropped when only one op is possible, and walking
  isn't offered while a usable target is visible. Live Jev runs showed it is strong at "which
  option" (0.9 to 1.0 confidence) and weak at abstract "what now" questions.
- **Two stuck detectors.** The per-sub-goal watchdog (`src/agent/watchdog.ts`) ends one sub-goal
  that spins. The run-level loop detector (`src/agent/loopDetector.ts`) trips when, with no XP or
  items gained, the player stays within 20 tiles for 8 minutes or the last 30 actions are three
  clicks over and over, across sub-goals. With `--rescue`, its evidence (top actions, positions,
  game messages) goes to the LLM to diagnose and break the loop or abandon the goal; the third
  verdict ends the run, and the strategy remembers the failed phase.
- **Exact instances.** Options address NPCs by client index and objects/items by id + tile, so the
  click lands on the entity the model chose, not the nearest one with that name.
- **`keep` lists** stop drop/deposit options (including deposit-all) for tools the sub-goal
  protects.
- **Destination ranking is straight-line distance.** The web walker finds the real path, but the
  "nearest" bank can be behind a toll gate or a river (e.g. Al Kharid from Lumbridge Swamp). Give
  the planner a `destination` when it matters.
- **Skill requirements are curated** (`src/kb/resources.ts`) for common trees, rocks and fishing
  spots. Extend it for other skills.
- **Wiki data** is CC BY-NC-SA 3.0. The OpenRS2 cache is Jagex's; keep `data/` local (it's
  gitignored).

## Tests

```bash
npm test               # offline: fake agent server + scripted decider (no API calls)
npm run typecheck
npm run test:live-jev     # a few Jev calls, including a full chop/bank loop on the fake client
npm run test:live-claude  # Claude planner/escalator (skips without ANTHROPIC_API_KEY)
```

Java: `./gradlew :client:runUnitTests --tests "*agentserver*"` (JDK 17).

