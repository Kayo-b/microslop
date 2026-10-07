# Running agent-engine against live OSRS (Linux, Jagex account)

This is the exact setup used for the first live runs: Omarchy/Arch Linux (Wayland), a Jagex
account, and Microbot started from this repository's source tree.

> **Account risk.** Automating OSRS breaks Jagex's rules and can get the account banned. Use a
> throwaway account.

## One-time setup

### 1. Tooling

```bash
mise install java@temurin-17      # Microbot's Gradle daemon requires JDK 17 specifically
cd ~/projects/Microbot_/agent-engine
npm install
npm run kb:dump && npm run kb:wiki && npm run kb:build   # knowledge base -> data/kb.sqlite
```

Put API keys in the repo-root `.env` (gitignored): `JEV_API_KEY=...`, plus
`ANTHROPIC_API_KEY=...` if you want the Claude planner (`--goal`) or escalator (`--escalate`).

### 2. Bolt, for the Jagex account login

A Jagex account can only log in through a launcher, and the official launcher has no Linux build.
Bolt is the open-source replacement. Build it from source; the GitHub release is outdated and its
login no longer works:

```bash
scripts/linux/build-bolt.sh                 # -> ~/.local/opt/bolt-0.24 (no root needed)
install -m 755 scripts/linux/bolt-microbot scripts/linux/microbot-run ~/.local/bin/
```

`bolt-microbot` starts Bolt with JDK 17 and runs its embedded browser through XWayland. On native
Wayland the **Character** dropdown doesn't register a selection, and Play then fails with
"please log in and select a character to play".

### 3. Sign in to the Jagex account once

`bolt-microbot`, click **Log in**, finish the Jagex sign-in, then close Bolt. Picking a character
and pressing Play are not needed.

Bolt keeps the game session in `~/.local/share/bolt-launcher/creds`. Before each launch
`microbot-run` reads it, asks Jagex for the account's characters (the same call Bolt makes on
startup) and writes `~/.config/microbot-jx/session.env` (mode 600). `microbot-run --refresh`
does only that step; exit code 3 means the session expired and you need to sign in with Bolt
again. With several characters, set `MICROBOT_CHARACTER=<display name>` (default: the last one
used, else the first).

Both files are login tokens. Log out in Bolt and delete `session.env` when you stop
experimenting. `microbot-run --capture` (copy the session from a RuneLite window Bolt launched)
still works as a fallback.

## Every session

```bash
microbot-run          # starts Microbot from ~/projects/Microbot_ on JDK 17 and auto-logs in
```

First run only: in the client open **Configuration** (wrench icon), search `Agent Server`, and
enable **[M] Agent Server**. Keep Bind mode = TCP and Stealth bind = off. The setting persists.

Check the server:

```bash
cd ~/projects/Microbot_ && ./microbot-cli state          # logged in? position?
cd agent-engine
npm run agent -- inspect --goal "chop trees" --targets Tree --decide   # decides, never clicks
```

`microbot-run` compiles the working tree, so Java changes (e.g. to `/snapshot`) only need a
client restart. Stop the client with the window's close button, or
`kill $(ps -eo pid,args | awk '/[j]ava .*net\.runelite\.client\.RuneLite/{print $1}')`.
After a restart the client sits at the login screen; log in without touching the window with
`curl -X POST -H "X-Agent-Token: $(cat ~/.runelite/.agent-token)" -H 'Content-Type: application/json' -d '{"wait":true,"world":316}' 127.0.0.1:8081/login`
(use a free-to-play world for a free account).
Avoid `pkill -f RuneLite` from a shell whose own command line contains that text: it kills the
shell too.

## Running the agent

| Command | What it does |
|---|---|
| `npm run agent -- presets` | list scripted tasks |
| `npm run agent -- run --task chop-trees --bank` | gather loop, banking when full |
| `npm run agent -- run --task mine-copper --until-level 30` | gather until a level |
| `npm run agent -- run --task kill-chickens --max-subgoals 10` | fight and loot loop |
| `npm run agent -- run --subgoal "bury all bones" --targets Bones --actions Bury --done-lacks Bones` | one sub-goal with a deterministic finish |
| `npm run agent -- run --goal "..." --escalate` | open-ended goal planned by Claude |

`--subgoal` completion flags: `--done-lacks ITEM`, `--done-has ITEM[:COUNT]`, `--done-full`,
`--max-steps N`, `--keep "axe,net"` (never drop or deposit these).

Keep each sub-goal to **one activity**. In live runs the classifier was excellent at "which option"
but, given "kill a chicken, then pick up the feathers", kept attacking instead of looting.
Sequencing belongs to the planner (the task trees and the Claude planner already work this way).

Ctrl+C stops after the current step and cancels any active walk.

## Training data

Every run appends to `logs/agent/<run-id>/steps.jsonl`: the compact state and option lists the
model saw, its answers with probabilities, the action, and the verified outcome.

```bash
npm run dataset:export     # -> data/dataset/decisions.jsonl
```

This keeps verified-successful model decisions (with soft targets) and successful escalations. See
the README's "Training data for Laya" section for how it maps onto Laya fine-tuning.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Cannot reach Microbot agent server` | client not running, Agent Server off, or Stealth bind on |
| `/snapshot` returns HTTP 500 about `java.util` | old build; pull and restart (fixed by avoiding `Collections.emptyList()`) |
| Bolt login window closes without saving the account | old Bolt build; use `build-bolt.sh` (0.24) |
| "please log in and select a character to play" | only with `--capture`: pick a character; if the dropdown won't hold it, start Bolt via `bolt-microbot` (XWayland) |
| Game window is official RuneLite, no `[M]` plugins | Bolt launched RuneLite; close it and use `microbot-run` |
| Gradle: "Cannot find a Java installation ... JVM version '17'" | `mise install java@temurin-17`; the scripts pick it up |
| Client stuck on `LOGGING_IN`, or `microbot-run` exits 3 | session expired; sign in with `bolt-microbot` again (step 3) |
