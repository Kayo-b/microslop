# Activity prerequisites

Every `agent run` (`--task`, `--strategy`, `--plan`) checks what its activity needs before it
starts, and runs the setup that is missing. Activities used to find out mid-run that they had no
axe, one arrow, no food or no body armour, and ended "impossible".

```bash
npm run agent -- prereq --task kill-barbarians      # dry run on the logged-in account
npm run agent -- run --task chop-oaks --bank         # setup (if any) runs first
npm run agent -- run --task chop-oaks --no-prereq    # old behaviour
npm run agent -- run --strategy level --setup-budget 45
```

## What is checked (`src/prereq/needs.ts`)

Derived from the activity definition, so new presets need no extra table:

| Need | From | Met when |
|---|---|---|
| levels, quests, combat, quest points | catalog `Requirement`; gathering presets' lowest target level (oaks: Woodcutting 15) | account has them |
| tools | preset `keep` (axe, pickaxe, net, rod), cooking (axe + tinderbox), smithing (hammer) | one is owned (carried, worn or banked) |
| consumables | feathers for fly fishing | owned count >= min |
| gear | fights against monsters that hit back: weapon, head, body, legs, shield per style | each slot has usable gear owned |
| food | `minFood`, or 5 for monsters that hit back | cooked food owned >= that |
| ranged/magic kit | combat style | coins cover bow/staff + 100 arrows/casts (the kit planner buys them) |
| inputs | cooking presets (raw fish) | banked |

## How it is met (`src/prereq/resolve.ts`)

In order: training or quest phases from the plan compiler (`requirementMilestones`), then
purchases, then food (fish and cook shrimp), then input materials (their gathering preset).
Setup phases have needs of their own (training Woodcutting buys an axe first).

- **Purchases**: starter tools from `ACQUIRE`; anything else from the cheapest shop in the KB's
  stock tables whose keeper location is known (`SHOP_LOCATIONS` in `catalog.ts`). Gear: the best
  metal tier the levels allow that costs at most a third of the coins owned, else the cheapest.
- **Coins**: when purchases cost more than the account owns, the best money route that needs
  nothing itself runs first (no missing tools, gear or food; fights need combat 15 above the
  route's requirement), then its products are sold on the Grand Exchange (`sell` phase,
  `ge_sell` action at 70% of guide price, noted withdraws).

## Budget

The setup's estimated minutes are compared with `--setup-budget` (default 30). Over budget, the
activity ends `impossible` with the plan as the reason, so the campaign and strategies move on to
something cheaper; a setup phase that fails goes to skip memory (`data/strategy-failures.json`).
The check runs again after setup, and when the activity gives up for a fixable reason (out of
arrows, no coins, no tool).
