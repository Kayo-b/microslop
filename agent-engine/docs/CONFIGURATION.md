# Configuring runs and campaigns

## Environment (`.env` at the repo root, gitignored)

Loaded by `npm run agent`, `npm run campaign`, `dataset:eval` via `--env-file-if-exists=../.env`.

| Variable | Default | Used for |
|---|---|---|
| `DECISION_ENGINE` | `jev` | `jev` or `laya`; `--engine` overrides per run |
| `JEV_API_KEY` (`TYPESAFE_API_KEY`) | | hosted Jev (the teacher) |
| `JEV_BASE_URL`, `JEV_MODEL` | `https://api.typesafe.ai`, `jev-latest` | |
| `LAYA_URL`, `LAYA_MODEL`, `LAYA_API_KEY` | `http://127.0.0.1:8000`, unset, unset | local Laya server ([LAYA_FINETUNING.md](LAYA_FINETUNING.md)) |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL` | provider with a key set | planner / escalator / rescue backend; `--llm` and `--llm-model` override |
| `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` | `claude-sonnet-5-5` | `--llm anthropic` |
| `LLM_TIER1_MODEL`, `LLM_TIER2_MODEL` | `claude-haiku-4-5`, `claude-sonnet-5-5` | tiered planner for `--plan` runs |
| `CLAUDE_CODE_TOOLS` | `WebSearch,WebFetch,Read,Grep,Glob` | tools of `--llm claude-code` (`default` = all, `""` = none) |
| `CLAUDE_CODE_CWD`, `CLAUDE_CODE_MAX_BUDGET_USD`, `CLAUDE_CODE_ARGS`, `CLAUDE_CODE_BIN` | agent-engine dir | Claude Code backend details |
| `MICROBOT_HOST`, `MICROBOT_PORT` | `127.0.0.1`, `8081` | which client the agent talks to |
| `MICROBOT_TOKEN`, `MICROBOT_TOKEN_FILE` | `~/.runelite/.agent-token` | agent-server token |
| `MICROBOT_RUN` | `microbot-run` | what the campaign launches when the client is down |

Set `MICROBOT_PORT` / `MICROBOT_TOKEN_FILE` / `MICROBOT_RUN` in the shell or systemd unit (not
`.env`) when running a second character, otherwise both would share them.

`microbot-campaign` / `microbot-run` environment: `MICROBOT_DIR` (checkout, default
`~/projects/Microbot`; **set it to `~/projects/Microbot_`**), `MICROBOT_CAMPAIGN_HOURS` (default
3), `MICROBOT_CHARACTER`, `MICROBOT_KEEP_CLIENT=1`, `MICROBOT_SESSION_FILE`, `BOLT_CREDS`.
`microbot-run-jar`: `CLIENT_HOME`, `AGENT_PORT`, `REBUILD=1`, `MICROBOT_DIR`.

## `agent run` flags

Anything after `run` in a campaign activity's `args` is one of these. Source: `src/cli.ts`.

### What to run (pick one)

| Flag | Meaning |
|---|---|
| `--task PRESET` | scripted task (`npm run agent -- presets`) |
| `--goal "TEXT"` | open goal planned by the LLM |
| `--subgoal "TEXT"` | one sub-goal; with `--targets A,B`, `--actions X,Y` |
| `--strategy level\|money\|gold\|quest` | strategy; `--skill S --level N` for `level`, `--quest NAME` for `quest` |
| `--flow gold [--option ID]` | strict option tree; without `--option` it picks the best option that can be set up |
| `--plan FILE` | plan file ([PLANS.md](PLANS.md)); `--account NAME` overrides the account state dir |

### Behaviour

| Flag | Meaning |
|---|---|
| `--bank` | bank instead of drop (gathering tasks) |
| `--until-level N` | stop at a level (gathering, `smith-progression`); `--metal` picks the smithing metal |
| `--max-subgoals N` | stop after N sub-goals (campaigns pass 1000) |
| `--max-steps N` | per sub-goal step cap |
| `--keep "axe,net"` | items never dropped/deposited |
| `--done-lacks ITEM`, `--done-has ITEM[:COUNT]`, `--done-full`, `--done-near X,Y,PLANE`, `--done-bank-open`, `--done-bank-closed`, `--done-shop-open`, `--done-equipped X`, `--done-object-near X` | deterministic finish conditions for `--subgoal` |
| `--dest PLACE`, `--dest-at X,Y,PLANE` | walk target for `--subgoal` |
| `--make-amount N` | amount for production sub-goals |
| `--no-prereq` | skip the prerequisites flow ([PREREQUISITES.md](PREREQUISITES.md)) |
| `--setup-budget MIN` | setup time cap before an activity ends `impossible` (default 30; flows ignore it) |

### Decision engine and LLM

| Flag | Meaning |
|---|---|
| `--engine jev\|laya` | System 1 classifier for this run |
| `--min-confidence 0.4` | below it the answer escalates (if `--escalate`) |
| `--escalate` | LLM overrides low-confidence picks (these become training data) |
| `--rescue` | LLM proposes a sub-goal when a planner gives up or the watchdog/loop detector trips (logged to `data/rescues.jsonl`) |
| `--llm P`, `--llm-model M` | backend and model for planning/escalation/rescue |
| `--rescue-model M` | model for rescues only (e.g. `haiku`); planning keeps `--llm-model` |

### Paths

`--log-dir logs/agent`, `--kb data/kb.sqlite`.

## Campaign config (JSON, `--config FILE`)

Any field of `DEFAULT_CONFIG` (`src/campaign/runner.ts`) can be overridden; CLI flags override the
file.

```json
{
  "hours": 4,
  "minutesPerActivity": 25,
  "breakMinutes": [1, 3],
  "cooldownRounds": 3,
  "rebuildEvery": 4,
  "world": 316,
  "restartClient": false,
  "rescue": false,
  "llm": "claude-code",
  "llmModel": "sonnet",
  "rescueModel": "haiku",
  "activities": [
    { "name": "smelt-steel", "args": ["--flow", "gold", "--option", "smelt-steel"], "weight": 1, "minutes": 55 }
  ]
}
```

| Field | Meaning |
|---|---|
| `hours` | total time (`--hours`, or `MICROBOT_CAMPAIGN_HOURS` in the wrapper) |
| `minutesPerActivity` | default slice; an activity's own `minutes` wins (quests 45) |
| `breakMinutes` | random pause between activities `[min, max]` |
| `cooldownRounds` | rounds an activity sits out after `impossible`/`error` |
| `rebuildEvery` | rebuild the dataset every N activities (0 = never) |
| `world` | login world (`--world`); 302 for members |
| `restartClient` | relaunch the client when the server is unreachable (`--restart-client`) |
| `rescue`, `llm`, `llmModel`, `rescueModel` | as the flags above |
| `plan` | run this plan file instead of the rotation |
| `activities[]` | see below |

Activity fields: `name`, `args` (everything after `agent run`), `weight` (default 1; weighted
random pick, never the same twice in a row when there is another choice), `needsLlm` (skipped
without an LLM), `minutes`, `final` (ending complete/impossible ends the campaign: used by plan
runs).

A one-activity config with weight 1 is how a single flow is kept running for hours: the activity
ends at its time budget (`timeout - time budget used`), a 1-3 min break follows, and it restarts
(the strategy resumes from the real account, so progress carries over).

### Configs in use

See [CAMPAIGN.md](CAMPAIGN.md#campaign-configs-in-use).

## Strategy and catalog knobs

| What | Where |
|---|---|
| Training brackets per skill, money routes, quests, gold routes (`GOLD`), `recommend` levels, `food`, requirements | `src/strategy/catalog.ts` |
| Skill requirements for trees/rocks/fishing spots, food heal values, stations | `src/kb/resources.ts` |
| Scripted presets (gathering, combat, cooking) | `src/planner/TaskTreePlanner.ts`, `CookingPlanner.ts`, `SmithingPlanner.ts` |
| Trading loops | `src/goalplan/{Tanning,Stringing,Herblore}Planner.ts` |
| Flow option tree | `src/flows/FlowPlanner.ts` |
| GE prices, buy scaling | `src/prereq/prices.ts`, `src/goalplan/buyScale.ts` |
| Watchdog / loop detector thresholds | `src/agent/watchdog.ts`, `src/agent/loopDetector.ts` (8 min within 20 tiles, or 30 actions repeating 3 clicks) |
| Skip memory (two failures in 12 h) | `src/strategy/skips.ts` -> `data/strategy-failures.json` |
| Reflexes (eat, flee, halt, run, level-up) | `src/engine/reflexes.ts` |

Rules for catalog changes (gold fights, gear smithed not bought, route giving up after repeated
blocks) are in [STRATEGY.md](STRATEGY.md). Add a scripted planner for any `llm` method that keeps
getting rescued: each one scripted is an LLM call that stops happening (`data/rescues.jsonl`).

## Tests before you launch

```bash
npm run typecheck
npm test                      # offline, fake agent server
cd .. && ./gradlew :client:compileJava    # after Java changes
```
