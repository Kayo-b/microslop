# Running two characters

The Jagex account has two characters. Both can run at once, **each in its own client**, never
more than 2 concurrently from this machine/IP.

| | Character 1 | Character 2 |
|---|---|---|
| Display name | `<char1-name>` | `<char2-name>` (members) |
| Code | `~/projects/microslop` (`main`), one checkout for both | same checkout |
| Data/logs home (`MICROBOT_ENGINE_HOME`) | `agent-engine/` (`data/`, `logs/`) | `~/.microbot-char2-home/agent-engine/` (`kb.sqlite` symlinked to char 1's) |
| Client home | `~/.runelite` | `~/.microbot-char2-home` |
| Agent server port | 8081 | 8082 |
| Token | `~/.runelite/.agent-token` | `~/.microbot-char2-home/.runelite/.agent-token` |
| Session file | `~/.config/microbot-jx/session.env` | `~/.config/microbot-jx/session-char2.env` |
| Client launcher | `microbot-run` (gradle, compiles the tree) | `~/.config/microbot-jx/run-char2.sh` -> `microbot-run-jar` (private jar copy `~/.microbot-char2-home/client.jar`) |
| Systemd unit | `microbot-jev-data` | `microbot-char2` |
| Usual world | 316 (F2P) | 302 (members, needed for herblore) |

Both characters run the same code. Each engine process runs with its data home as cwd and
`MICROBOT_ENGINE_HOME` set (`src/paths.ts`), so datasets, ledgers and logs are per character. Env vars used for the second client are the same ones
`microbot-cli` and the backend read: `MICROBOT_PORT`, `MICROBOT_TOKEN_FILE`, `MICROBOT_HOST`,
`MICROBOT_TOKEN`; `MICROBOT_RUN` makes the campaign relaunch through the right launcher.

## Files

| File | What |
|---|---|
| `~/.config/microbot-jx/run-char2.sh` | exports `CLIENT_HOME`, `MICROBOT_CHARACTER=<char2-name>`, `MICROBOT_SESSION_FILE`, `AGENT_PORT=8082`, then execs `microbot-run-jar` |
| `~/.config/microbot-jx/session-char2.env` | `JX_SESSION_ID`, `JX_CHARACTER_ID`, `JX_DISPLAY_NAME` (login tokens, mode 600) |
| `agent-engine/scripts/linux/microbot-run-jar` | starts a regular client from `$CLIENT_JAR` (default `runelite-client/build/libs/*-shaded.jar`) with `-Duser.home=$CLIENT_HOME`; seeds the client home once from `~/.runelite` with the agent port moved |
| `agent-engine/data/campaign/char2-herblore.json`, `char2-gold.json` | its campaign configs |

## Launching both

```bash
make gold-rebuild-char2     # build the shaded jar in the shared tree, copy it for char 2 (Java changes only)
make gold-start WHO=both    # char 1 + char 2 as systemd units (scripts/linux/gold-run)
make gold-status WHO=both
```

Engine (TypeScript) changes need no rebuild, only a restart of the run. Character 2's campaign
configs live in its own `data/campaign/` (`gold-run` reads `CHAR2_CONFIG` relative to its data home).
The old `~/projects/Microbot_*` checkouts are no longer used and can be deleted once both
characters have run cleanly from here.
