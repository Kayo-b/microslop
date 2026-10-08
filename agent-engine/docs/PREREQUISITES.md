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
| loadout | every activity except tutorial, selling and buying | a weapon and head/body/legs/shield owned (bought when missing and affordable; never blocks or earns coins), then **worn**: carried gear is wielded, better banked gear fetched (`src/prereq/loadout.ts`, up to 8 steps before the activity) |
| bank materials | quest and LLM activities | potions, herbs, ore, bars, logs, raw food and hides carried at the start are deposited first (`MATERIALS` in `src/engine/drops.ts`) |
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
- **Gear**: an empty slot gets the cheapest piece that fills it. Better gear is never bought:
  coins are kept for making money, and gear is smithed instead (`smith-progression`, the gold
  strategy's `gear` phase; see [STRATEGY.md](STRATEGY.md)).
- **Shop or GE**: GE prices come from the OSRS Wiki real-time API (`prices.runescape.wiki`, cached
  6 h in `data/cache/ge-prices.json`). An item not in `ACQUIRE` is bought on the GE when its price
  +30% (the `ge_buy` overbid, refunded on fill) beats the cheapest shop. Without the API, shops only.
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

## Selling: value check

The sell phase compares a quick Grand Exchange sale (70% of guide, minus 2% tax) with a general store (40% of store value) and skips the Grand Exchange for items a store pays more for. `make-agent price ITEMS="Cowhide"` shows the numbers for any item. NPC selling itself is not automated: the agent server has no shop-sell action yet.

## Nothing valuable is dropped

`src/engine/drops.ts`: the engine offers `Drop` only for worthless items (burnt food, ashes, bronze/iron junk, empty jugs/pots/vials, bones, goblin mail). Gather presets that used to drop their product (`bank: false`) bank it instead, and the LLM planner prompt tells Claude to free space by banking, never by dropping.

## Free accounts stay out of members areas

`src/strategy/f2p.ts` lists the free-to-play map (mainland, dungeons, Musa Point, Crandor, Corsair Cove, Camdozaal). A free account's quest run stops with `impossible` (and skip memory moves on) when Quest Helper's current step lies outside it, and the quest prompt tells the planner to stay in free areas. Quests the catalog does not know count as members quests. Members accounts are not restricted.
