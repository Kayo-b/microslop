# Agent engine quickstart: commands and important files

One page to get the engine working, run both characters, gather data and feed Laya. Each theme
has its own page; this one links to them.

| Theme | Page |
|---|---|
| Data gathering (logs, dataset sources, coverage) | [DATA_GATHERING.md](DATA_GATHERING.md) |
| Laya fine-tuning (dataset -> Kaggle -> serve -> eval -> A/B) | [LAYA_FINETUNING.md](LAYA_FINETUNING.md) |
| Running agents (modes, campaigns, systemd, monitoring) | [RUNNING_AGENTS.md](RUNNING_AGENTS.md) |
| Configuring runs and campaigns (flags, JSON, env, catalog) | [CONFIGURATION.md](CONFIGURATION.md) |
| Two characters at once | [TWO_CHARACTERS.md](TWO_CHARACTERS.md) |
| Machine setup, Bolt, Jagex session | [RUNNING.md](RUNNING.md) |
| Campaign runner, scheduling, monitor alerts | [CAMPAIGN.md](CAMPAIGN.md) |
| Strategies, gold routes, flows, rescue | [STRATEGY.md](STRATEGY.md) |
| Plans, prerequisites | [PLANS.md](PLANS.md), [PREREQUISITES.md](PREREQUISITES.md) |

## One-time setup

```bash
cd ~/projects/Microbot_/agent-engine
npm install
npm run kb:dump && npm run kb:wiki && npm run kb:build      # -> data/kb.sqlite (~2 min)
mise install java@temurin-17
scripts/linux/build-bolt.sh && install -m 755 scripts/linux/bolt-microbot scripts/linux/microbot-run ~/.local/bin/
bolt-microbot                                               # sign in to Jagex once, close Bolt
# repo-root .env: JEV_API_KEY=...   (ANTHROPIC_API_KEY only for --llm anthropic)
# first client start: Configuration -> search "Agent Server" -> enable [M] Agent Server (TCP, stealth bind off)
```

## Daily commands

```bash
# status
systemctl --user is-active microbot-jev-data microbot-char2
npm run agent -- monitor                       # char 1 campaign
cd ~/projects/Microbot_-char2/agent-engine && npm run agent -- monitor    # char 2 campaign

# launch both characters (details and the full systemd-run lines: TWO_CHARACTERS.md)
#  char 1: microbot-campaign --config data/campaign/smelt-2026-10-06.json  --llm claude-code --rescue-model haiku --rescue
#  char 2: runner.ts       --config data/campaign/char2-herblore.json --world 302 --restart-client ...

# stop
systemctl --user stop microbot-jev-data microbot-char2

# one-off runs
npm run agent -- run --flow gold --option smelt-steel
npm run agent -- run --task chop-trees --bank
npm run agent -- inspect --goal "chop trees" --targets Tree --decide

# data and Laya
npm run dataset:build
npm run dataset:eval -- --engine laya --model osrs-v1
LAYA_CHECKPOINT=~/laya_models/laya-osrs-agent-v1 ~/projects/laya/.venv/bin/python ~/laya_models/serve_osrs.py

# checks
npm run typecheck && npm test
cd ~/projects/Microbot_ && ./gradlew :client:compileJava
```

## Important files

### In the repo (`agent-engine/`)

| Path | Why it matters |
|---|---|
| `src/cli.ts` | every `agent` command and `run` flag |
| `src/campaign/runner.ts`, `monitor.ts` | campaign loop, `DEFAULT_CONFIG`, status screen |
| `src/engine/GameIntentEngine.ts`, `candidates.ts`, `reflexes.ts`, `verify.ts`, `log.ts` | the tick loop, options, reflexes, effect verification, step log |
| `src/decision/adapters.ts` | Jev / Laya selection |
| `src/strategy/catalog.ts` | training brackets, money and gold routes, quests |
| `src/flows/FlowPlanner.ts` | `--flow` option tree |
| `src/goalplan/{Tanning,Stringing,Herblore}Planner.ts`, `src/planner/SmithingPlanner.ts` | scripted gold loops |
| `src/prereq/` | tools, gear, food, coins, levels before a run |
| `src/dataset/` | export, reverse, synth, build, evaluate |
| `src/tools/transfer.ts` | coin transfer between the two characters |
| `scripts/linux/microbot-run`, `microbot-campaign` | client launcher and unattended session wrapper |
| `kb-dumper/`, `src/kb/` | knowledge base |
| `data/campaign/*.json` | campaign configs (gitignored) |
| `data/dataset/{train,eval}.jsonl`, `mix-stats.json` | training data |
| `data/gold-ledger.jsonl`, `rescues.jsonl`, `strategy-failures.json`, `bank-seen.json` | state and results |
| `logs/agent/<run>/steps.jsonl`, `logs/campaign/<id>/` | everything that happened |

### Outside the repo

| Path | What |
|---|---|
| `~/projects/Microbot_-char2` | second character's checkout (branch `feat/char2`) |
| `~/.config/microbot-jx/{session.env,session-char2.env,run-char2.sh}` | Jagex sessions (tokens) and the char 2 launcher |
| `~/.local/share/bolt-launcher/creds` | Bolt's login (source of the sessions) |
| `~/.runelite/`, `~/.microbot-char2-home/.runelite/` | client homes, tokens, logs |
| `~/.cache/microbot-run.log` | stdout of relaunched clients (both characters) |
| `~/projects/laya`, `~/laya_models/` | Laya source and checkpoints (`laya-osrs-agent-v1`, `serve_osrs.py`) |
| `~/.kaggle/access_token` | Kaggle CLI token (datasets, training kernels) |

### Java side

`runelite-client/.../microbot/agentserver/` (`SnapshotHandler`, `ActHandler`, `GameMessageLog`);
endpoints in `docs/AGENT_SERVER.md`, CLI in `docs/MICROBOT_CLI.md`.

## Rules to keep it working

- At most 2 characters logged in at once (one per client).
- Members content on world 302; F2P world 316 hides members GE items.
- Always pass `MICROBOT_CAMPAIGN_HOURS` and `MICROBOT_DIR=~/projects/Microbot_` to the wrapper,
  and `PATH`/`HOME` to `systemd-run`.
- Char 2 runs a shaded jar: rebuild it after Java changes.
- Never self-train: Laya's own decisions are excluded from the dataset; evaluate Laya through A/B.
- Back up `logs/agent` and `data/dataset` before cleaning; they are gitignored.
- Fix entity-assumption bugs in `microbot/util/` with a gotcha note in `docs/entity-guides/`.
