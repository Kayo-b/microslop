# Unattended campaigns and LLM backends

## Campaign runner

```bash
npm run campaign -- --dry-run                     # show the rotation, run nothing
npm run campaign -- --hours 4                      # scripted activities only
npm run campaign -- --hours 6 --llm claude-code --rescue --restart-client
npm run campaign -- --only fish-shrimp,range-cows --hours 1
npm run campaign -- --config my-campaign.json      # override any field of DEFAULT_CONFIG
npm run campaign -- --plan plans/NAME.json --hours 6 --restart-client   # one plan instead of the rotation (PLANS.md)
```

Each round: check the client (relaunch with `--restart-client`, log in to `--world`, default 316)
-> pick a weighted activity -> `agent run ...` in its own process for up to 25 min (45 for quests)
-> record the outcome -> 1-4 min break -> rebuild the dataset every 4 activities.

- Activities that end `impossible`/`error` sit out 3 rounds; the same activity never runs twice in
  a row when there is another choice.
- `quests` (and any activity marked `needsLlm`) runs only when an LLM is configured.
- Three failed recoveries in a row stop the campaign: the Jagex session has probably expired;
  sign in again with `bolt-microbot` (see RUNNING.md).
- Ctrl+C ends the current activity (its walk is cancelled) and stops.

Output: `logs/campaign/<id>/campaign.log`, one log per activity, `summary.jsonl`; every decision
also lands in `logs/agent/` as usual, so `npm run dataset:build` picks it up.

## Scheduling (unattended, no clicks)

`scripts/linux/microbot-campaign [campaign args]` is one full session: refresh the Jagex session
from Bolt's creds (no Bolt window, character pick or Play) -> campaign with `--restart-client`
(starts Microbot, logs in through `/login`) -> stop the client it started -> `dataset:build` ->
desktop notification. A lock keeps two sessions from overlapping.

```bash
mkdir -p ~/.config/systemd/user
cp scripts/linux/systemd/microbot-campaign.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now microbot-campaign.timer       # daily, 14:00-16:00
systemctl --user start microbot-campaign                     # run one now
journalctl --user -u microbot-campaign -f
systemctl --user edit microbot-campaign    # e.g. Environment=MICROBOT_CAMPAIGN_HOURS=5
```

| Env | Default | |
|---|---|---|
| `MICROBOT_CAMPAIGN_HOURS` | 3 | also raise `RuntimeMaxSec` (5h) when going above ~4 |
| `MICROBOT_CHARACTER` | last used | display name, for accounts with several characters |
| `MICROBOT_KEEP_CLIENT` | 0 | 1 leaves the client running afterwards |

It is a user unit because the client needs the desktop session: it only runs while you are
logged in to the desktop. Exit code 3 plus a critical notification means the Jagex session
expired: sign in with `bolt-microbot` once (closing Bolt afterwards is fine); the next run picks
it up. Extra campaign flags go in `ExecStart=` (e.g. `--llm claude-code --rescue` to enable
quests).

## Monitoring a running campaign

```bash
npm run agent -- monitor              # since the latest campaign started
npm run agent -- monitor --hours 1    # a recent window only
```

One screen, read-only: the systemd unit state, the current activity and its phase, LLM rescues
(by model and trigger, success = the rescue's sub-goal ended `done`, recurring reasons, the latest
five with their outcome), gold phases with coins and gp/h (`data/gold-ledger.jsonl`), the phases
skip memory is holding back, and alerts:

| Alert | Meaning / what to do |
|---|---|
| activity log silent 10+ min | agent hung: check `journalctl --user -u microbot-jev-data`, the client (`./microbot-cli state`) |
| rescue never helps with "X" (3x+) | the LLM cannot get past X: fix it in code (planner, candidates, walker) |
| rescue success under 30% | the rescue model is not coping; compare models by the per-model lines |
| N rescue calls errored | the `claude` CLI failed or timed out (model name, login, rate limits) |
| campaign unit is inactive/failed | the campaign ended or crashed |

Comparing rescue models: run the same campaign with `--rescue-model haiku` (rescues only; planning
keeps `--llm-model`), or `--llm-model haiku` for everything, and
read the per-model lines; each rescue records its `rescuer` (`claude-code:<model>`). Stop a
campaign between activities by waiting for its `■` line in `campaign.log` before
`systemctl --user stop microbot-jev-data` (stopping ends the running activity at once). Never
`systemctl kill -s STOP` the unit: the game client is in the same cgroup and freezes too.

## LLM backends

Used by `--goal`, `--rescue`, `--escalate`, LLM strategy phases and quests.

| `--llm` / `LLM_PROVIDER` | Key | Notes |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | default model `claude-sonnet-5-5` |
| `claude-code` | none: uses Claude Code's own login | `claude -p --output-format json --json-schema ... --dangerously-skip-permissions` |
| `openai`, `openrouter`, `groq`, `together`, `gemini`, `deepseek`, `mistral`, `xai` | `<PROVIDER>_API_KEY` or `LLM_API_KEY` | OpenAI-compatible `/chat/completions` with json_schema output |
| `ollama`, `lmstudio` | none | local servers |
| anything else | `LLM_BASE_URL` (+ `LLM_API_KEY`) | any OpenAI-compatible endpoint |

`--llm-model` / `LLM_MODEL` picks the model. Without `--llm`, the provider whose key is set is
used; Claude Code is only used when named.

### Claude Code

- Runs with `--dangerously-skip-permissions`, so the spawned agent never stops to ask. Its tools
  are limited to read-only research by default (`CLAUDE_CODE_TOOLS=WebSearch,WebFetch,Read,Grep,Glob`,
  e.g. to look up a quest step); `CLAUDE_CODE_TOOLS=default` gives it every tool, `""` none.
- `CLAUDE_CODE_CWD` sets what Read/Grep can see (default: the agent-engine directory);
  `CLAUDE_CODE_MAX_BUDGET_USD` caps each call; `CLAUDE_CODE_ARGS` appends raw flags.
- The prompt contains game state (NPC names, game messages; never player chat). With more
  tools than the default, treat it like running an agent on untrusted text.
- About 4 s and $0.03 per planner call with Sonnet.

## Campaign configs in use

Gitignored, in `data/campaign/` (each character's checkout has its own):

| File | What |
|---|---|
| `gaps-2026-09-30.json` | gap-weighted rotation used for the first overnight data runs |
| `thin-areas-2026-10-06.json` | LLM-planned `--goal` activities for thin dataset areas (firemaking, thieving, fletching, crafting, cooking, runecrafting, smelting, quests, range-cows) |
| `quests-2026-10-01.json`, `quests-only-2026-10-01.json` | quest sessions (`--strategy quest`, 45 min) |
| `ab-laya-v1-2026-10-05.json` | every activity twice, `@jev` / `@laya` ([LAYA_FINETUNING.md](LAYA_FINETUNING.md#7-ab-in-game)) |
| `gold-2026-10-06.json` | `--strategy gold`, 55 min slices (rotation through gold routes) |
| `smelt-2026-10-06.json` | `--flow gold --option smelt-steel`, 55 min slices |
| `char2-gold.json`, `char2-herblore.json` | second character: `--flow gold` / `--flow gold --option herblore` ([TWO_CHARACTERS.md](TWO_CHARACTERS.md)) |

Config fields and `agent run` flags: [CONFIGURATION.md](CONFIGURATION.md). Launch commands:
[RUNNING_AGENTS.md](RUNNING_AGENTS.md).
