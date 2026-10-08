# Command shortcuts

Everything in the other docs, as one-liners. Install once, then ask each group for its list:

```bash
make dev-install-cli        # symlinks the wrappers into ~/.local/bin (run from agent-engine/)

make-gold --help            # start/stop gold campaigns and skill plans (wraps gold-run)
make-agent --help           # look at and run the agent by hand: strategy, flow, plan show, run-*
make-data-gathering --help  # unattended sessions, dataset build/export
make-laya --help            # freeze data, Kaggle, serve, eval
make-level --help           # level any skill, free or paid accounts
make-dev --help             # typecheck, tests, KB
make help                   # all groups (inside agent-engine/)
```

Usage: `make-<group> <target> [VAR=value ...]`; `make -n` style preview: `make-gold plan -n PLAN=...`.
`CHAR=2` points `make-agent`/`make-data-gathering` at character 2 (its checkout, port 8082, token).

```bash
make-gold start WHO=2                                      # char 2 default campaign, until 23:59
make-gold plan PLAN=plans/gold-1-hunter.json WHO=2 HOURS=6 # a skill plan (docs/GOLD_PLANS.md)
make-gold crafting                                         # char 1 craft-jewellery + tan-hides
make-gold status ; make-gold logs WHO=2 ; make-gold stop
make-agent strategy CHAR=2                                 # account profile + next phase
make-agent plan-show PLAN=plans/gold-2-smithing.json CHAR=2
make-agent run-flow OPTION=craft-jewellery CHAR=2
make-data-gathering session HOURS=3                        # login refresh -> campaign -> dataset
make-laya freeze
make-level list MEMBERS=f2p                                # every training method; f2p hides members-only
make-level list SKILL=Agility
make-level fishing TO=60 CHAR=2                            # also: attack strength defence ranged magic ... (all 24 skills)
make-level skill SKILL=Smithing TO=50                      # any skill by name
make-level lowest                                          # whichever skill is lowest
```

`make-level` starts an **unattended job** by default (`scripts/linux/agent-job`): it starts the client,
logs in, runs as a systemd unit and restarts after crashes, like `make-gold`. Watch and stop it with
`make-gold status|logs|stop WHO=<char>`. `HOURS=` limits it. `FG=1` runs in your terminal against an
already running client instead. One job per character at a time (they share the character's unit).

Free vs paid: `make-level` uses the logged-in account's membership (varp 1780) and skips members-only
methods on a free account, so the same command works for both. Methods marked `llm` in
`make-level list` are driven by Claude plus Jev/Laya and are less tested than the `script` ones.

The targets live in `agent-engine/Makefile`; edit the `## description` text there and the help
updates. Details per command: [GOLD_PLANS.md](GOLD_PLANS.md), [CAMPAIGN.md](CAMPAIGN.md),
[RUNNING_AGENTS.md](RUNNING_AGENTS.md), [DATA_GATHERING.md](DATA_GATHERING.md),
[LAYA_FINETUNING.md](LAYA_FINETUNING.md).

## How `make-level` moves up as levels rise

After every phase the strategy re-reads the levels and takes the first catalog method whose bracket
holds the current level (`make-level list SKILL=Mining` shows them):

| Skill | Brackets |
|---|---|
| Mining | copper/tin 1-15, iron 15-30, coal 30-55, mithril 55-70, adamantite 70-99 (Dwarven Mine, coal onwards) |
| Smithing | one `smith-progression` method: bronze, iron, steel, then mithril (Smithing 50 and Mining 55) and adamant (70 and 70) bars and gear |
| Herblore | `herblore-train`: the recipe with the most XP an hour that the coins can buy and that loses at most 250 gp a potion: cleaning, then finished potions (attack at 3 up to magic at 76) |

| Fishing | shrimps 1-20, fly fishing 20-35, harpoon tuna/swordfish at Musa Point 35-99 (LLM-driven); members from 58: barbarian fishing |
| Woodcutting | trees 1-15, oaks 15-30, willows 30-60, yews at Edgeville 60-99; members from 75: magic trees (LLM-driven) |
| Cooking | shrimps 1-15, trout/salmon 15-30, tuna 30-40, lobsters 40-45, swordfish 45-99; raw fish not banked is caught first |

Mithril and adamant smithing, the Dwarven Mine presets and the finished-potion recipes are new and
untested on a live client.
