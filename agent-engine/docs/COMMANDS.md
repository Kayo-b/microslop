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

Free vs paid: `make-level` uses the logged-in account's membership (varp 1780) and skips members-only
methods on a free account, so the same command works for both. Methods marked `llm` in
`make-level list` are driven by Claude plus Jev/Laya and are less tested than the `script` ones.

The targets live in `agent-engine/Makefile`; edit the `## description` text there and the help
updates. Details per command: [GOLD_PLANS.md](GOLD_PLANS.md), [CAMPAIGN.md](CAMPAIGN.md),
[RUNNING_AGENTS.md](RUNNING_AGENTS.md), [DATA_GATHERING.md](DATA_GATHERING.md),
[LAYA_FINETUNING.md](LAYA_FINETUNING.md).
