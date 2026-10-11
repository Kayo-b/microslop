# Important files and rules

## In the repo (`agent-engine/`)

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

## Outside the repo

| Path | What |
|---|---|
| `~/.microbot-char2-home/agent-engine` | second character's data/logs home (`MICROBOT_ENGINE_HOME`) |
| `~/.config/microbot-jx/{session.env,session-char2.env,run-char2.sh}` | Jagex sessions (tokens) and the char 2 launcher |
| `~/.local/share/bolt-launcher/creds` | Bolt's login (source of the sessions) |
| `~/.runelite/`, `~/.microbot-char2-home/.runelite/` | client homes, tokens, logs |
| `~/.cache/microbot-run.log` | stdout of relaunched clients (both characters) |
| `~/projects/laya`, `~/laya_models/` | Laya source and checkpoints (`laya-osrs-agent-v1`, `serve_osrs.py`) |
| `~/.kaggle/access_token` | Kaggle CLI token (datasets, training kernels) |

## Java side

`runelite-client/.../microbot/agentserver/` (`SnapshotHandler`, `ActHandler`, `GameMessageLog`);
endpoints in `docs/AGENT_SERVER.md`, CLI in `docs/MICROBOT_CLI.md`.

## Rules to keep it working

- At most 2 characters logged in at once (one per client).
- Members content on world 302; F2P world 316 hides members GE items.
- Always pass `MICROBOT_CAMPAIGN_HOURS` and `MICROBOT_DIR=~/projects/microslop` to the wrapper,
  and `PATH`/`HOME` to `systemd-run`.
- Char 2 runs a shaded jar: rebuild it after Java changes.
- Never self-train: Laya's own decisions are excluded from the dataset; evaluate Laya through A/B.
- Back up `logs/agent` and `data/dataset` before cleaning; they are gitignored.
- Fix entity-assumption bugs in `microbot/util/` with a gotcha note in `docs/entity-guides/`.
