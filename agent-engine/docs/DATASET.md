# Laya fine-tuning dataset

```bash
npm run dataset:build     # export + reverse + synthetic -> data/dataset/{train,eval}.jsonl + mix-stats.json
npm run dataset:export    # only logged decisions      -> data/dataset/decisions.jsonl
npm run dataset:reverse   # only reverse-generated     -> data/dataset/reverse.jsonl
npm run dataset:synth     # only rule-labelled         -> data/dataset/synthetic.jsonl
```

Every line is a `/v1/systemone` request (`state`, `questions`) plus `labels` (hard) and `soft`
(distribution), `source` and `outcome`.

| Source | How labels are made | Teaches |
|---|---|---|
| `model` | Jev's choice, kept when the action's effect was verified in the next snapshot | real play |
| `reverse` | pick an option in a logged state, write the sub-goal that calls for it; equivalent options share the soft label | reading the goal across ~900 goals, actions never chosen live |
| `synthetic` | computed from the KB: weakest/strongest monster, best resource for a level, product -> resource, tool for a resource, best food, most valuable drop, best usable weapon/bow, station for a process | OSRS knowledge |

Eval holds out whole runs (hash of run id, ~10%) and every 10th synthetic example.

Size check: the requests average ~590 tokens (~p99 750, estimated at 3.5 chars/token), close to
Laya's 768 head length. Truncate `game_messages`/`recent_actions` first if needed.

Grows automatically: every agent run logs its decisions to `logs/agent/<run>/steps.jsonl`, so
re-running `dataset:build` after more play adds both real decisions and reverse examples from
the new states.
