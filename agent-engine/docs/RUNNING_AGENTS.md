# Running agents

Ways to run the engine, from one sub-goal to unattended multi-hour campaigns. Machine setup
(Bolt, Jagex session, JDK) is in [RUNNING.md](RUNNING.md); this page is the command reference.
All commands run in `agent-engine/`.

## Preconditions

1. Client up with **[M] Agent Server** enabled, logged in (`./microbot-cli state` from the repo
   root answers). Port 8081, token `~/.runelite/.agent-token`.
2. `data/kb.sqlite` exists (`npm run kb:dump && npm run kb:wiki && npm run kb:build`).
3. Repo-root `.env` has `JEV_API_KEY` (and `ANTHROPIC_API_KEY` only if using the Anthropic API;
   `--llm claude-code` needs no key, it uses the local `claude` login).
4. Members content (herblore, members GE items) needs a **members world** (302). F2P world 316
   hides members items in the GE search.

## Starting the client

```bash
microbot-run                         # refresh Jagex session, compile working tree, launch, auto-login
microbot-run --refresh               # only refresh the session (exit 3: sign in again with bolt-microbot)
curl -X POST -H "X-Agent-Token: $(cat ~/.runelite/.agent-token)" -H 'Content-Type: application/json' \
  -d '{"wait":true,"world":316}' 127.0.0.1:8081/login     # log in without touching the window
```

Campaigns start the client themselves with `--restart-client`.

## Looking before acting

```bash
npm run agent -- presets                                          # scripted tasks
npm run agent -- inspect --goal "chop trees" --targets Tree --decide   # one snapshot, shows options and the decision, clicks nothing
npm run agent -- strategy                                         # account profile + next phase per strategy
npm run agent -- flow gold                                        # the gold option tree for the logged-in account
npm run agent -- prereq --task kill-barbarians                    # what the activity needs first
npm run agent -- plan show plans/example-combat-90s.json [--offline [--f2p]]
npm run agent -- monitor [--hours 2]                              # running campaign status
```

## `agent run` modes

| Mode | Command | Use |
|---|---|---|
| scripted task | `run --task chop-trees --bank` | gather / fight loops from `PRESETS` (`presets` lists them) |
| one sub-goal | `run --subgoal "bury all bones" --targets Bones --actions Bury --done-lacks Bones` | deterministic finish |
| open goal | `run --goal "get 10 mining at the nearest copper/tin mine" --escalate` | Claude/LLM plans sub-goals |
| strategy | `run --strategy level\|money\|gold\|quest` | picks phases from the catalog |
| flow | `run --flow gold --option herblore` | strict: one option + only its own sub-flows |
| plan | `run --plan plans/example-combat-90s.json` | roadmap toward a build ([PLANS.md](PLANS.md)) |

Gold flow options (`src/strategy/catalog.ts`): `cowhides`, `iron-ore`, `willow-logs`,
`trout-salmon`, `lobsters`, `hill-giants`, `moss-giants`, `yew-logs`, `tan-hides`,
`sand-crabs-herbs`, `feathers`, `guard-coins`, `smelt-steel`, `herblore`, `string-amulets`,
`pickpocket-men`, `wool`. Trading loops with their own planner: `tan-hides`, `string-amulets`,
`herblore`, `smelt-steel`.

### Useful flags

See [CONFIGURATION.md](CONFIGURATION.md) for the complete table. The ones you reach for:

```
--bank  --until-level N  --max-subgoals N  --max-steps N  --keep "axe,net"
--engine jev|laya  --min-confidence 0.4
--rescue  --llm claude-code  --llm-model M  --rescue-model haiku
--no-prereq  --setup-budget 45
```

Ctrl+C stops after the current step and cancels any active walk.

## Campaigns

A campaign runs `agent run` repeatedly in its own processes, keeps the client alive and rebuilds
the dataset. Full description in [CAMPAIGN.md](CAMPAIGN.md).

```bash
npm run campaign -- --config data/campaign/gold-2026-10-06.json --dry-run     # show the rotation
npm run campaign -- --config CFG --hours 6 --world 316 --restart-client --llm claude-code --rescue-model haiku --rescue
npm run campaign -- --only fish-shrimp,range-cows --hours 1
npm run campaign -- --plan plans/example-combat-90s.json --hours 6 --restart-client
```

### As a transient systemd unit (how campaigns were launched yesterday)

`microbot-campaign` wraps the run: refresh session -> campaign -> stop the client it started ->
`dataset:build` -> notification. A user unit keeps it alive when the terminal closes and lets you
`stop` it cleanly.

```bash
ENGINE=$HOME/projects/Microbot_/agent-engine
H=$(python3 -c "import datetime as d;n=d.datetime.now();print(round((n.replace(hour=23,minute=59)-n).total_seconds()/3600,1))")   # hours until 23:59
systemd-run --user --unit=microbot-jev-data --working-directory=$ENGINE \
  --setenv=MICROBOT_DIR=$HOME/projects/Microbot_ --setenv=MICROBOT_CAMPAIGN_HOURS=$H \
  --setenv=PATH="$PATH" --setenv=HOME="$HOME" \
  $ENGINE/scripts/linux/microbot-campaign --config data/campaign/smelt-2026-10-06.json \
  --llm claude-code --rescue-model haiku --rescue
```

The wrapper defaults to 3 h, so always pass `MICROBOT_CAMPAIGN_HOURS`. `PATH` and `HOME` must be
set explicitly (transient units start with a bare environment; node comes from mise).

```bash
systemctl --user is-active microbot-jev-data
journalctl --user -u microbot-jev-data -f
systemctl --user stop microbot-jev-data             # ends the running activity at once, stops the client
systemctl --user reset-failed microbot-jev-data     # needed before reusing the unit name after a failure
```

Never `systemctl kill -s STOP` the unit: the client is in the same cgroup and freezes too. To
stop between activities wait for the `■` line in `campaign.log`.

### Two characters at once

At most **2** characters logged in at once from this machine/IP, each in its own client. See
[TWO_CHARACTERS.md](TWO_CHARACTERS.md) for the second character's checkout, port and unit.

## Stopping and cleaning up

```bash
systemctl --user stop microbot-jev-data microbot-char2
ps -eo pid,args | grep '[n]et.runelite.client.RuneLite'      # leftover clients
kill <pid>                                                   # never `pkill -f RuneLite` from a shell whose own command line contains that text
```

## Monitoring

```bash
npm run agent -- monitor                                     # since the latest campaign started
tail -f logs/campaign/$(ls logs/campaign | tail -1)/campaign.log
tail -f logs/campaign/$(ls logs/campaign | tail -1)/*.log    # per-activity logs (strategy/flow lines, phase ends)
./microbot-cli state                                         # from the repo root (second character: MICROBOT_PORT=8082 MICROBOT_TOKEN_FILE=...)
```

Campaign alerts and what they mean are in [CAMPAIGN.md](CAMPAIGN.md#monitoring-a-running-campaign).

## Troubleshooting quick table

| Symptom | Fix |
|---|---|
| `agent server unreachable: relaunching the client` stays | client is compiling/starting (first launch ~1-2 min); if it persists see `journalctl --user -u <unit>` and the Gradle output |
| exit 3 from `microbot-run --refresh` | Jagex session expired: `bolt-microbot`, log in, close Bolt |
| activity ends `halted: hp N/M and no food` | food prerequisite failed; check bank and `prereq --task` |
| `stuck in a loop: 8 min within 20 tiles` | run-level loop detector; with `--rescue` the LLM diagnoses first |
| `offer_failed (item search or price entry did not complete)` | GE widget ids changed after a game update: pull newer GameVals from upstream (`chsami/Microbot`) |
| `exit code 143` | the activity was SIGTERM'd (campaign time budget, stop, or restart) |
| GE shows no grimy herbs | on F2P world; use `--world 302` |
| Client JVM starts but never opens the agent server; `jstack` shows `main` in `X11GraphicsEnvironment.initDisplay`; both clients vanished at once | Xwayland crashed (`coredumpctl list` shows `SIGABRT /usr/bin/Xwayland`, seen 2026-10-06 22:40 and 2026-10-07 07:05) and the lazy `:0` socket hangs new clients. Quick fix without touching the desktop: `setsid Xwayland :1 -rootless -noreset &` and relaunch the units with `systemd-run ... --setenv=DISPLAY=:1`. Proper fix: log out and in. A crash kills every running client, so campaigns relaunch them forever; stop the units first |
| Java change not picked up | restart the client (`microbot-run` compiles the tree; the second character uses a **shaded jar**, rebuild it: see TWO_CHARACTERS.md) |
