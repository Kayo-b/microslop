# agent-engine

A structured state → decision → action loop for Microbot. It reads the game through the Agent
Server's `/snapshot`, asks a System 1 classifier (TypeSafe Jev, or a local Laya) to pick from a
short list of concrete options, performs the choice through `/act` (Microbot's normal
synthetic-click interactions, never packet injection), verifies the effect, and logs every
decision as future training data. Long-horizon planning is either a scripted task tree or
Claude Sonnet.

> **Account risk.** This drives the live OSRS client. Automating gameplay breaks Jagex's rules
> and can get an account banned. Use a throwaway account.

## How it fits together

```
 planner (task tree | Claude Sonnet)          ── called when a sub-goal starts/ends
        │ sub-goal: text, targets, actions, destination, done-when, keep
        ▼
 GameIntentEngine.step()                      ── once per tick
   GET /snapshot ─► reflexes (eat, halt, level-up, run)
                ─► busy gate (walking / animating / in combat → wait)
                ─► candidates: one option per (target, action), KB-enriched labels
                ─► Jev / Laya: op? target? destination?  (only the questions rules can't settle)
                ─► low confidence? → Claude escalator (optional)
                ─► POST /act ─► verify effect from snapshot diffs + game messages
                ─► logs/agent/<run>/steps.jsonl
```

| Path | What |
|---|---|
| `kb-dumper/` | Java dumper over Microbot's `cache` module: items, NPCs, objects, object placements, map labels |
| `src/kb/` | wiki scraper (spawns, monsters, shops), SQLite builder, `KnowledgeBase` query API, curated skill requirements |
| `src/backend/` | `/snapshot` + `/act` client |
| `src/decision/` | `/v1/systemone` adapters (Jev hosted, Laya local) |
| `src/engine/` | candidates, compact state, reflexes, verification, step log, `GameIntentEngine` |
| `src/planner/` | task trees + gathering presets, declarative completion conditions |
| `src/llm/` | Claude planner and escalator |
| `src/agent/`, `src/cli.ts` | run loop and CLI |
| `src/dataset/` | step logs → fine-tuning examples |

The Java side lives in `runelite-client/.../microbot/agentserver/` (`SnapshotHandler`, `ActHandler`,
`GameMessageLog`); endpoints are documented in `docs/AGENT_SERVER.md`.

## Setup

Requirements: Node 24+, JDK 17 for Gradle (`mise install java@temurin-17`), a Microbot build with
this branch.

```bash
cd agent-engine
npm install

# Knowledge base (one-off, ~2 min; re-run after big game updates)
npm run kb:dump     # downloads the latest OSRS cache from OpenRS2, dumps definitions/placements
npm run kb:wiki     # NPC spawns, monster stats, shops from the OSRS Wiki
npm run kb:build    # -> data/kb.sqlite
```

Secrets go in the repo-root `.env` (gitignored):

| Variable | Used for |
|---|---|
| `JEV_API_KEY` | TypeSafe Jev (default decision engine) |
| `ANTHROPIC_API_KEY` | Claude planner (`--goal`) and escalator (`--escalate`) |
| `DECISION_ENGINE` | `jev` (default) or `laya` |
| `LAYA_URL`, `LAYA_MODEL`, `LAYA_API_KEY` | local `laya-serve` (default `http://127.0.0.1:8000`) |
| `CLAUDE_MODEL` | default `claude-sonnet-5-5` |
| `MICROBOT_HOST`, `MICROBOT_PORT`, `MICROBOT_TOKEN` | agent server (defaults `127.0.0.1:8081`, token from `~/.runelite/.agent-token`) |

## First live run

1. Build and start the client (`./gradlew :client:assemble` or run from your IDE), log in, and
   enable the **Agent Server** plugin.
2. Look before acting. This takes one snapshot, prints what the engine would show the model, and
   asks Jev, without clicking anything:
   ```bash
   npm run agent -- inspect --goal "chop trees" --targets "Tree" --decide
   ```
3. Short scripted run. Stand near trees with an axe, then:
   ```bash
   npm run agent -- run --task chop-trees --max-subgoals 1
   ```
   Ctrl+C stops after the current step and cancels any walk.
4. Longer loops: `--bank` banks instead of dropping, `--until-level 15` stops at a level.
   `npm run agent -- presets` lists the tasks.
5. Open goals through Claude (needs `ANTHROPIC_API_KEY`):
   ```bash
   npm run agent -- run --goal "get 10 mining at the nearest copper/tin mine" --escalate
   ```

Each run writes `logs/agent/<run-id>/steps.jsonl` containing the exact state and options the model
saw, its answers and probabilities, the action taken, and the verified outcome.

## Tests

```bash
npm test               # offline: fake agent server + scripted decider (no API calls)
npm run typecheck
npm run test:live-jev     # a few Jev calls, including a full chop/bank loop on the fake client
npm run test:live-claude  # Claude planner/escalator (skips without ANTHROPIC_API_KEY)
```

Java: `./gradlew :client:runUnitTests --tests "*agentserver*"` (JDK 17).

## Training data for Laya

```bash
npm run dataset:export   # logs/agent/*/steps.jsonl -> data/dataset/decisions.jsonl
```

Each example is a `/v1/systemone` request (`state`, `questions`) with gold `labels` and, for
model decisions, the teacher's probability distribution as `soft` targets. Only verified-successful
actions and successful escalations are kept. Laya's RLCD recipe trains on soft targets, and the
browser-agent write-up in `laya/docs/finetune_browser_agent.md` describes the input format that
worked best (options in the question, compact state). After fine-tuning, point `laya-serve` at the
checkpoint and set `DECISION_ENGINE=laya`; nothing else changes.

## Design notes and known limits

- **The classifier only gets real choices.** Waiting, eating, level-up dialogs, and completion
  checks are deterministic. The op question is dropped when only one op is possible, and walking
  isn't offered while a usable target is visible. Live Jev runs showed it is strong at "which
  option" (0.9 to 1.0 confidence) and weak at abstract "what now" questions.
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
