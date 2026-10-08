# Gold-unlock plans

Skill plans that raise a character to the level where a high-paying method from the OSRS wiki
([Skilling](https://oldschool.runescape.wiki/w/Money_making_guide/Skilling),
[Collecting](https://oldschool.runescape.wiki/w/Money_making_guide/Collecting)) opens up. Files are
in `plans/`, format in [PLANS.md](PLANS.md). They write their state to `data/accounts/char2/`.

| Plan | Target | Unlocks (wiki gp/h) | Runs as |
|---|---|---|---|
| `gold-1-hunter` | Hunter 46 | snowy knights 979k (35), mixed hide bases 1.9M (46) | LLM + Jev |
| `gold-2-smithing` | Smithing 50 | mithril bars at Blast Furnace 1.7M | scripted (`smelt-steel`) |
| `gold-3-crafting` | Crafting 45 | opal 536k (16), jade 538k (34), topaz 1.0M (45) | scripted (`craft-jewellery`) |
| `gold-4-herblore` | Herblore 65 | sanfew serum 2.5M (65), prayer potions 960k (38) | scripted (`herblore`) |
| `gold-5-magic` | Magic 55 | sac jacking 2.1M, high alching 514k | scripted to 13, then needs `--llm` |
| `gold-6-runecraft` | Runecraft 27 | Guardians of the Rift 1.1M | LLM + Jev |

Suggested order: 1, 2, 3, then 4 and 5 (long grinds). Hours in `plan show` are estimates; the
account ledger replaces them after the first run.

The training methods behind the plans are the `Herblore`, `Crafting`, `Smithing`, `Hunter` and
`Runecraft` entries marked "Gold-unlock skills" in `src/strategy/catalog.ts`. The Hunter and
Runecraft ones are LLM-driven (Claude plans sub-goals, Jev/Laya picks the clicks) and not scripted.

## Look first

```bash
export MICROBOT_PORT=8082 MICROBOT_TOKEN_FILE=$HOME/.microbot-char2-home/.runelite/.agent-token   # char 2
npm run agent -- plan show plans/gold-1-hunter.json             # roadmap for the logged-in account
npm run agent -- plan show plans/gold-1-hunter.json --offline   # roadmap for a fresh account
npm run agent -- strategy                                       # account profile + next phase
npm run agent -- flow gold                                      # gold options for the account
```

## Run a plan

With the launcher (systemd unit, survives the terminal; world 302 for members):

```bash
gold-run start 2 -- --plan plans/gold-1-hunter.json          # until 23:59
gold-run start 2 --hours 6 -- --plan plans/gold-4-herblore.json
gold-run status 2 ; gold-run logs 2 ; gold-run stop 2
```

By hand, from `~/projects/Microbot_-char2/agent-engine` (see [CAMPAIGN.md](CAMPAIGN.md)):

```bash
npm run campaign -- --plan plans/gold-1-hunter.json --hours 6 --restart-client --world 302 \
  --llm claude-code --rescue-model haiku --rescue
npm run agent -- run --plan plans/gold-3-crafting.json         # one run against the logged-in client
npm run agent -- llm-report --plan plans/gold-1-hunter.json    # LLM use, what to script next
```

A plan campaign slices into 45-minute runs and ends when the target is reached or nothing can
progress. LLM and quest phases are skipped without `--llm`.

## Run the gold loops themselves

```bash
CHAR2_CONFIG=data/campaign/char2-gold.json gold-run start 2          # planner picks the best option
CHAR1_CONFIG=data/campaign/char1-crafting.json gold-run start 1      # craft-jewellery + tan-hides
npm run agent -- run --flow gold --option craft-jewellery            # one option, strict
npm run agent -- run --strategy gold                                 # rotate every route that fits
gold-run start 2 -- --dry-run                                        # show the rotation only
```

## Monitor and stop

```bash
gold-run status                       # unit state + campaign monitor
npm run agent -- monitor --hours 1    # since the latest campaign / a window
gold-run stop 2                       # ends the running activity and stops the client
```

## Getting the plans onto character 2

The plans and catalog live on `feat/agent-engine`; character 2's checkout merges them:

```bash
gold-run rebuild-char2    # merge feat/agent-engine into feat/char2, rebuild the shaded jar
```
