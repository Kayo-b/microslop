# Microbot Hub plugins as training methods

Some methods run a [Microbot Hub](https://github.com/chsami/Microbot-Hub) plugin instead of the engine's
own clicks. `HubPluginPlanner` (`src/goalplan/HubPluginPlanner.ts`) does what the plugin cannot:
restock at the Grand Exchange (sell products, buy supplies), take out carried/worn items, walk to
the start, then set the plugin's config (`POST /settings/plugin`), start it (`/scripts/start`) and
watch the XP. No XP for a few minutes stops the plugin and re-checks the bank; the target level
completes the phase; the plugin is stopped when the agent exits (SIGTERM included).

Catalog entries use `exec: { kind: 'hub', spec: '<id>' }`; specs live in `src/goalplan/hubSpecs.ts`.

| Spec | Plugin (jar) | Picks |
|---|---|---|
| `alch` | `AIOMagicPlugin` | Low/High Alchemy on the best-value item at live prices (unstrung yew longbows / rune arrows high-alch at a profit; gold bars on free worlds); items already owned first |
| `agility` | `MicroAgilityPlugin` | rooftop course by level (Draynor 10 ... Seers' 60) |
| `gotr` | `GotrPlugin` | Guardians of the Rift; sells rift runes except nature/fire; needs Temple of the Eye (the level strategy does the quest chain first) |
| `smithing` | `AutoSmeltingPlugin` + `VarrockAnvilPlugin` | free accounts: smelt bought ore for profit (Edgeville), smith the platebody with the best XP/hour once paid for by smelting (Varrock West); adamant platebodies (88+) cost ~0.4 gp/xp |
| `mahogany` | `MahoganyHomesPlugin` | Mahogany Homes tier by Construction level; planks + steel bars kept above the plugin's stop thresholds |

## Installing the jars

Sideloaded jars load at client start from `<client home>/.runelite/microbot-plugins/<InternalName>.jar`
(char 1: `~/.runelite/...`, char 2: `~/.microbot-char2-home/.runelite/...`). Get the URL and sha256
from `https://chsami.github.io/Microbot-Hub/plugins.json`, check the hash, copy, restart the client.
They are disabled by default; the planner starts and stops them. `pluginState` says "not loaded"
(the phase ends impossible) when a jar is missing.

## Gotchas

- Plugins that stop themselves (out of bars, ore) stay "active" to the plugin manager: the planner
  relies on the XP stall, not the plugin state.
- Some plugins pop a Swing message box when they stop (`Microbot.showMessage`); harmless.
- The run watcher counts rising total XP as progress (the agent only waits while a plugin trains).
- Only bulk-traded products: 2,500 low-volume items (platelegs, bronze) would sink the price.
