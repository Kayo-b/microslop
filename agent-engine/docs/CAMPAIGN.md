# Unattended campaigns and LLM backends

## Campaign runner

```bash
npm run campaign -- --dry-run                     # show the rotation, run nothing
npm run campaign -- --hours 4                      # scripted activities only
npm run campaign -- --hours 6 --llm claude-code --rescue --restart-client
npm run campaign -- --only fish-shrimp,range-cows --hours 1
npm run campaign -- --config my-campaign.json      # override any field of DEFAULT_CONFIG
```

Each round: check the client (relaunch with `--restart-client`, log in to `--world`, default 316)
-> pick a weighted activity -> `agent run ...` in its own process for up to 25 min (45 for quests)
-> record the outcome -> 1-4 min break -> rebuild the dataset every 4 activities.

- Activities that end `impossible`/`error` sit out 3 rounds; the same activity never runs twice in
  a row when there is another choice.
- `quests` (and any activity marked `needsLlm`) runs only when an LLM is configured.
- Three failed recoveries in a row stop the campaign: the Jagex session has probably expired;
  re-capture it with Bolt (`microbot-run --capture`, see RUNNING.md).
- Ctrl+C ends the current activity (its walk is cancelled) and stops.

Output: `logs/campaign/<id>/campaign.log`, one log per activity, `summary.jsonl`; every decision
also lands in `logs/agent/` as usual, so `npm run dataset:build` picks it up.

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
