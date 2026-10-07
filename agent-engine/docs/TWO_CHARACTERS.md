# Running two characters

The Jagex account has two characters. Both can run at once, **each in its own client**, never
more than 2 concurrently from this machine/IP.

| | Character 1 | Character 2 |
|---|---|---|
| Display name | `<char1-name>` | `<char2-name>` (members) |
| Checkout | `~/projects/Microbot_` (branch `feat/agent-engine`) | `~/projects/Microbot_-char2` (branch `feat/char2`, merges `feat/agent-engine`) |
| Client home | `~/.runelite` | `~/.microbot-char2-home` |
| Agent server port | 8081 | 8082 |
| Token | `~/.runelite/.agent-token` | `~/.microbot-char2-home/.runelite/.agent-token` |
| Session file | `~/.config/microbot-jx/session.env` | `~/.config/microbot-jx/session-char2.env` |
| Client launcher | `microbot-run` (gradle, compiles the tree) | `~/.config/microbot-jx/run-char2.sh` -> `microbot-run-jar` (shaded jar) |
| Systemd unit | `microbot-jev-data` | `microbot-char2` |
| Usual world | 316 (F2P) | 302 (members, needed for herblore) |

The second checkout has its own `agent-engine/data` and `logs` (KB `kb.sqlite` is a symlink), so
datasets and ledgers are per character. Env vars used for the second client are the same ones
`microbot-cli` and the backend read: `MICROBOT_PORT`, `MICROBOT_TOKEN_FILE`, `MICROBOT_HOST`,
`MICROBOT_TOKEN`; `MICROBOT_RUN` makes the campaign relaunch through the right launcher.

## Files

| File | What |
|---|---|
| `~/.config/microbot-jx/run-char2.sh` | exports `CLIENT_HOME`, `MICROBOT_CHARACTER=<char2-name>`, `MICROBOT_SESSION_FILE`, `AGENT_PORT=8082`, then execs `microbot-run-jar` |
| `~/.config/microbot-jx/session-char2.env` | `JX_SESSION_ID`, `JX_CHARACTER_ID`, `JX_DISPLAY_NAME` (login tokens, mode 600) |
| `agent-engine/scripts/linux/microbot-run-jar` (in `Microbot_-char2`) | starts a regular client from `runelite-client/build/libs/*-shaded.jar` with `-Duser.home=$CLIENT_HOME`; seeds the client home once from `~/.runelite` with the agent port moved |
| `agent-engine/data/campaign/char2-herblore.json`, `char2-gold.json` | its campaign configs |

## Launching both (the sequence used 2026-10-07)

```bash
# 0. Keep the second checkout current, then rebuild its jar (Java changes are NOT picked up otherwise)
cd ~/projects/Microbot_-char2 && git merge feat/agent-engine
J17=$(mise where java@temurin-17)
JAVA_HOME=$J17 ./gradlew --no-daemon :client:shadowJar -q -Dorg.gradle.java.installations.paths=$J17

# 1. Character 1: smelt-steel
ENGINE=$HOME/projects/Microbot_/agent-engine
H=$(python3 -c "import datetime as d;n=d.datetime.now();print(round((n.replace(hour=23,minute=59)-n).total_seconds()/3600,1))")
systemctl --user reset-failed microbot-jev-data microbot-char2 2>/dev/null
systemd-run --user --unit=microbot-jev-data --working-directory=$ENGINE \
  --setenv=MICROBOT_DIR=$HOME/projects/Microbot_ --setenv=MICROBOT_CAMPAIGN_HOURS=$H \
  --setenv=PATH="$PATH" --setenv=HOME="$HOME" \
  $ENGINE/scripts/linux/microbot-campaign --config data/campaign/smelt-2026-10-06.json \
  --llm claude-code --rescue-model haiku --rescue

# 2. Character 2: herblore on a members world
T=$HOME/.microbot-char2-home/.runelite/.agent-token
systemd-run --user --unit=microbot-char2 \
  --working-directory=$HOME/projects/Microbot_-char2/agent-engine \
  --setenv=MICROBOT_PORT=8082 --setenv=MICROBOT_TOKEN_FILE=$T \
  --setenv=MICROBOT_RUN=$HOME/.config/microbot-jx/run-char2.sh \
  --setenv=PATH="$PATH" --setenv=HOME="$HOME" \
  $HOME/.local/share/mise/installs/node/26.10.0/bin/node --disable-warning=ExperimentalWarning \
  --env-file-if-exists=../.env src/campaign/runner.ts \
  --config data/campaign/char2-herblore.json --hours $H --world 302 --restart-client \
  --llm claude-code --rescue-model haiku --rescue
```

Character 2 runs `runner.ts` directly (not `microbot-campaign`) because the wrapper's lock
(`microbot-campaign.lock`) and session refresh belong to character 1.

Check both:

```bash
systemctl --user is-active microbot-jev-data microbot-char2
./microbot-cli state                                                       # char 1 (from ~/projects/Microbot_)
MICROBOT_PORT=8082 MICROBOT_TOKEN_FILE=$T ./microbot-cli state             # char 2
journalctl --user -u microbot-char2 -f
```

## Campaigns started on 2026-10-07 07:35

| Character | Campaign | Activity | World | Until |
|---|---|---|---|---|
| <char1-name> | `data/campaign/smelt-2026-10-06.json` | `--flow gold --option smelt-steel`, 55 min slices | 316 | 23:59 |
| <char2-name> | `data/campaign/char2-herblore.json` | `--flow gold --option herblore`, 55 min slices | 302 | 23:59 |

Both with `--llm claude-code --rescue-model haiku --rescue`. These are the same campaigns that
were running on 2026-10-06 evening (char 1: smelt-steel after tanning; char 2: herblore).
Yesterday char 1 earned ~275k from tanning, char 2 went 10k -> ~160k and Herblore 3 -> 22 in
~2.5 h.

## Moving coins between the characters

A normal trade at the GE (Jagex allows trading between your own characters). **Stop both
campaigns first**, log both in on the same world.

```bash
npm run agent -- transfer --from-port 8081 --from-name <char1-name> \
  --to-port 8082 --to-name <char2-name> --to-token ~/.microbot-char2-home/.runelite/.agent-token \
  --keep-coins 50000
```

Both walk to the GE, the giver withdraws all coins but `--keep-coins`, they trade, both accept
both screens, the receiver's coins are checked (`src/tools/transfer.ts`).

## Gotchas

- The second client uses the **shaded jar**, not Gradle: after any Java change
  (`runelite-client/...`) rebuild it with the `shadowJar` command above before relaunching.
  `REBUILD=1` in the environment of `microbot-run-jar` also forces it.
- The campaign's `--world` is applied at login; members content needs 302.
- The Jagex session for the second character comes from the same Bolt creds; exit 3 means sign
  in with `bolt-microbot` again.
- Never start a third client here.
