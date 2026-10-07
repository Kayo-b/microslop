# agent-engine

A structured state → decision → action loop for Microbot. It reads the game through the Agent
Server's `/snapshot`, asks a System 1 classifier (TypeSafe Jev, or a local Laya) to pick from a
short list of concrete options, performs the choice through `/act` (Microbot's normal
synthetic-click interactions, never packet injection), verifies the effect, and logs every
decision as future training data. Long-horizon planning is either a scripted task tree or
Claude Sonnet.

> **Account risk.** This drives the live OSRS client. Automating gameplay breaks Jagex's rules
> and can get an account banned. Use a throwaway account.

## Quick start: gold-run campaigns for both characters

`scripts/linux/gold-run` starts each character's campaign as a systemd user unit (survives
closing the terminal, stops cleanly). It launches the client, logs in, and rotates 55-minute
`--flow gold` activities until 23:59.

| | Character 1 `<char1-name>` | Character 2 `<char2-name>` |
|---|---|---|
| Campaign | `data/campaign/smelt-2026-10-06.json` (smelt-steel) | `data/campaign/char2-herblore.json` (herblore) |
| World | 316 (F2P) | 302 (members) |
| Checkout / port / unit | `~/projects/Microbot_` / 8081 / `microbot-jev-data` | `~/projects/Microbot_-char2` / 8082 / `microbot-char2` |

### One-time setup

Full walkthrough (Bolt, Jagex session, JDK, second checkout): [docs/RUNNING.md](docs/RUNNING.md),
[docs/TWO_CHARACTERS.md](docs/TWO_CHARACTERS.md).

```bash
cd ~/projects/Microbot_/agent-engine
npm install
npm run kb:dump && npm run kb:wiki && npm run kb:build       # -> data/kb.sqlite (~2 min)
mise install java@temurin-17
scripts/linux/build-bolt.sh
install -m 755 scripts/linux/{bolt-microbot,microbot-run,microbot-campaign,gold-run} ~/.local/bin/
bolt-microbot                                                # sign in to Jagex once, close Bolt
# repo-root .env: JEV_API_KEY=...   (--llm claude-code needs no key, it uses the local `claude` login)
# first client start: Configuration -> search "Agent Server" -> enable [M] Agent Server (TCP, stealth bind off)
```

### Daily

```bash
gold-run start            # both characters, until 23:59
gold-run start 1          # only character 1   (also: 2)
gold-run start both --hours 4
gold-run status           # unit state + campaign monitor (activity, rescues, gp/h, alerts)
gold-run logs 1           # follow journal (1 or 2)
gold-run stop             # ends running activity at once and stops the clients
gold-run rebuild-char2    # after Java changes: merge feat/agent-engine, rebuild char 2's shaded jar
```

Other campaign file or world: `CHAR1_CONFIG=data/campaign/gold-2026-10-06.json CHAR2_WORLD=302 gold-run start`.
Extra campaign flags go after `--`: `gold-run start both -- --dry-run`.
After an Xwayland crash run `DISPLAY=:1 gold-run start` (see the troubleshooting table in
[docs/RUNNING_AGENTS.md](docs/RUNNING_AGENTS.md)).

Rules: max 2 characters logged in at once; members content needs world 302; stop both campaigns
before trading coins between them. More in [docs/FILES.md](docs/FILES.md).

## Where to go next

| I want to... | Read |
|---|---|
| set up the machine, Bolt, the Jagex session, fix login | [docs/RUNNING.md](docs/RUNNING.md) |
| run one sub-goal, a task, a flow or a strategy by hand; look before acting; stop/clean up | [docs/RUNNING_AGENTS.md](docs/RUNNING_AGENTS.md) |
| run a different gold route (`cowhides`, `tan-hides`, `string-amulets`, ...) or other campaign | [docs/RUNNING_AGENTS.md](docs/RUNNING_AGENTS.md#agent-run-modes), [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| write a new campaign JSON, tune flags, env vars, LLM backends | [docs/CONFIGURATION.md](docs/CONFIGURATION.md), [docs/CAMPAIGN.md](docs/CAMPAIGN.md) |
| schedule daily sessions with a systemd timer; read monitor alerts | [docs/CAMPAIGN.md](docs/CAMPAIGN.md) |
| create a new gold option / strategy / flow | [docs/STRATEGY.md](docs/STRATEGY.md) (catalog, `FlowPlanner`, planners) |
| build a plan toward a stat build; set up tools, gear, food first | [docs/PLANS.md](docs/PLANS.md), [docs/PREREQUISITES.md](docs/PREREQUISITES.md) |
| run both characters in depth, move coins between them | [docs/TWO_CHARACTERS.md](docs/TWO_CHARACTERS.md) |
| gather data, build the dataset, fine-tune and A/B Laya | [docs/DATA_GATHERING.md](docs/DATA_GATHERING.md), [docs/DATASET.md](docs/DATASET.md), [docs/LAYA_FINETUNING.md](docs/LAYA_FINETUNING.md) |
| find a source file, state file or outside-repo path; see the rules | [docs/FILES.md](docs/FILES.md) |
| understand design choices, run tests | [docs/DESIGN.md](docs/DESIGN.md) |
| use the Java endpoints / CLI | [../docs/AGENT_SERVER.md](../docs/AGENT_SERVER.md), [../docs/MICROBOT_CLI.md](../docs/MICROBOT_CLI.md) |

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
| `src/llm/` | LLM planner, escalator, rescue, Haiku -> Sonnet tiers |
| `src/strategy/`, `src/goalplan/` | strategies and catalog; plan files compiled into roadmaps ([docs/PLANS.md](docs/PLANS.md)) |
| `src/prereq/` | activity prerequisites: tools, gear, food, kit coins, levels met before a run ([docs/PREREQUISITES.md](docs/PREREQUISITES.md)) |
| `src/agent/`, `src/cli.ts` | run loop and CLI |
| `src/dataset/` | step logs → fine-tuning examples |

The Java side lives in `runelite-client/.../microbot/agentserver/` (`SnapshotHandler`, `ActHandler`,
`GameMessageLog`); endpoints are documented in `docs/AGENT_SERVER.md`.
