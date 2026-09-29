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

## Baselines (eval.jsonl, 2026-09-29)

`npm run dataset:eval -- --engine laya` (needs `laya-serve` on :8000) or `--engine jev`.

| | all | logged (Jev labels) | reverse | synthetic | chance |
|---|---|---|---|---|---|
| Laya zero-shot (`typed-decisions`, 2,034 ex.) | 0.27 | 0.46 | 0.14 | 0.35 | 0.19 / 0.09 (reverse) |
| Jev (400 reverse + synthetic ex.) | 0.91 | n/a | 0.95 | 0.81 | 0.13 |

Top-1 against the hard label. Laya zero-shot is barely above chance, like the browser head before
fine-tuning (0.10); its confidence is 0.3-0.5 even when right. Jev is the teacher ceiling, except
on `rule:gear` (0.17): it picks the highest-tier weapon regardless of the level requirement, which
is knowledge the synthetic set adds. Gear labels rank by metal tier then weapon type; wiki
equipment bonuses would make cross-type comparisons exact.
