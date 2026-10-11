# Fine-tuning Laya

Laya is the local System 1 decision model meant to replace the hosted Jev teacher. The loop:

```
gather (Jev plays, every decision logged)  ->  dataset:build  ->  upload to Kaggle  ->  train (2x T4)
   ^                                                                                        |
   └──── A/B campaign (@jev vs @laya)  <-  agent --engine laya  <-  serve locally  <-  download checkpoint
```

Swapping engines is one setting: `DECISION_ENGINE=laya` (or `--engine laya`). The engine sends
the same `/v1/systemone` request to either (`src/decision/adapters.ts`).

## Important files and places

| Where | What |
|---|---|
| `src/dataset/{export,reverse,synth,build}.ts` | step logs -> training examples ([DATA_GATHERING.md](DATA_GATHERING.md)) |
| `src/dataset/evaluate.ts` | scores an engine on `eval.jsonl` (`npm run dataset:eval`) |
| `src/decision/adapters.ts`, `SystemOneHttpAdapter.ts` | Jev/Laya HTTP clients |
| `data/dataset/train.jsonl`, `eval.jsonl`, `mix-stats.json` | current training set (gitignored) |
| `data/dataset/eval-<engine>[-<model>]-<time>.json` | evaluation reports |
| `data/dataset/2026-09-29/` | a frozen snapshot (decisions + step logs tarball) |
| `~/projects/laya` | Laya source (`.venv` with CUDA torch, `laya-serve`), upstream notebooks in `notebooks/`, write-up `docs/finetune_browser_agent.md` |
| `~/laya_models/base` | base Laya checkpoint (ONNX encoder/head, tokenizer) |
| `~/laya_models/laya-osrs-agent-v1` | fine-tuned v1 (`model.safetensors`, `rl_agent_config.json`, `benchmark_report.json`, training log, `train_ddp.py`) |
| `~/laya_models/serve_osrs.py` | serves a local checkpoint on `127.0.0.1:8000` |
| Kaggle `<kaggle-user>/osrs-agent-decisions-v1` | private dataset (train/eval jsonl) |
| Kaggle `<kaggle-user>/laya-osrs-agent-finetune` | private training kernel |

## 1. Example format

Every line of `train.jsonl` / `eval.jsonl` is a `/v1/systemone` request plus labels:

```json
{
  "state": { "subgoal": "bury all the bones in the inventory", "location": "...", "inventory": "...", "skills": "...", "recent_actions": [], "game_messages": [] },
  "questions": { "target": { "type": "choice", "instructions": "Which action best serves the sub-goal ...?", "criteria": { "inv:2#Bury": "Inventory Bones (have 26): Bury", "...": "..." } } },
  "labels": { "target": "inv:2#Bury" },
  "soft":   { "target": { "inv:2#Bury": 0.97, "inv:3#Bury": 0.02 } },
  "source": "model | escalation | reverse | synthetic",
  "outcome": "...", "subgoal": "...", "engine": "jev", "runId": "...", "step": 12
}
```

- `labels` are hard targets; `soft` is the teacher's distribution (model rows) or the set of
  equally good options (reverse/synthetic). Laya's RLCD recipe trains on soft targets.
- Options live inside the question (`criteria`), with a compact state: the input format that
  worked best for the Laya browser agent (`~/projects/laya/docs/finetune_browser_agent.md`).

## 2. Build and freeze the dataset

```bash
cd ~/projects/microslop/agent-engine
npm run dataset:build && cat data/dataset/mix-stats.json
```

Optionally include the second character's logs (see [DATA_GATHERING.md](DATA_GATHERING.md#building-the-dataset)).
Freeze what you train on, so an eval stays comparable:

```bash
B=data/dataset/$(date +%F); mkdir -p $B
cp data/dataset/{train,eval}.jsonl data/dataset/mix-stats.json $B/
tar -czf $B/step-logs.tar.gz logs/agent
```

## 3. Token budget

The default Laya lengths (512 / head 192) truncate the option lists. Measured on this data: head
(question + options) p99 ~700 tokens, state p99 ~350. v1 used:

| Setting | Value |
|---|---|
| `MAX_LEN` | 1152 |
| `HEAD_MAX_LEN` | 768 |
| encoder | `answerdotai/ModernBERT-large`, 2 head layers |
| `max_tokens_per_batch` | 4096, bf16, gradient checkpointing |

They are saved into the checkpoint's `rl_agent_config.json`, so serving picks them up. Re-measure
when the state format changes (`src/engine/state.ts`).

## 4. Train on Kaggle (2x T4)

Kaggle CLI is installed via pipx (`kaggle`, user in `$KAGGLE_USER`, token `~/.kaggle/access_token`).

Upload a new dataset version:

```bash
D=$(mktemp -d); cp data/dataset/{train,eval}.jsonl $D/
kaggle datasets metadata <kaggle-user>/osrs-agent-decisions-v1 -p $D    # writes dataset-metadata.json
kaggle datasets version -p $D -m "$(date +%F): $(jq -c .train data/dataset/mix-stats.json)"
```

The kernel was generated from Laya's `notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb`,
with the prep cell changed to read our jsonl (`questions` + `soft` labels) and the eval cell
reporting top-1 by `source`. Pull it, adjust, push, wait, download:

```bash
K=~/laya_models/kernel; mkdir -p $K
kaggle kernels pull <kaggle-user>/laya-osrs-agent-finetune -p $K -m       # notebook + kernel-metadata.json
# edit: dataset version, epochs, MAX_LEN/HEAD_MAX_LEN, model_name (e.g. laya-osrs-agent-v2)
kaggle kernels push -p $K
until s=$(kaggle kernels status <kaggle-user>/laya-osrs-agent-finetune 2>&1); echo "$s" | grep -qiE 'COMPLETE|ERROR|CANCEL'; do sleep 120; done; echo "$s"
O=$(mktemp -d); kaggle kernels output <kaggle-user>/laya-osrs-agent-finetune -p $O
mv $O/laya_osrs_agent ~/laya_models/laya-osrs-agent-v2
cp $O/*.log $O/train_ddp.py ~/laya_models/laya-osrs-agent-v2/ 2>/dev/null
```

v1 (2026-10-04/05): fine-tuned from the base checkpoint on 17,835 training items (dataset of
20,544 rows), ~2 h on 2x T4 (Kaggle's weekly GPU quota applies).

## 5. Serve locally

`laya-serve` has no option for a local checkpoint path, so `serve_osrs.py` maps the default
("english") route to `LAYA_CHECKPOINT`:

```bash
LAYA_CHECKPOINT=~/laya_models/laya-osrs-agent-v1 ~/projects/laya/.venv/bin/python ~/laya_models/serve_osrs.py
# LAYA_HOST / LAYA_PORT override 127.0.0.1:8000; runs on CUDA (RTX 3060 6 GB is enough)
```

Agent-engine side (repo-root `.env` or the shell):

| Variable | Default |
|---|---|
| `DECISION_ENGINE` | `jev`; set `laya` to switch every run |
| `LAYA_URL` | `http://127.0.0.1:8000` |
| `LAYA_MODEL` | unset (the server's default route) |
| `LAYA_API_KEY` | unset |

## 6. Evaluate

```bash
npm run dataset:eval -- --engine laya --model osrs-v1                # all of eval.jsonl
npm run dataset:eval -- --engine laya --limit 500 --concurrency 4
npm run dataset:eval -- --engine jev --limit 400                      # teacher ceiling (costs API calls)
```

Reports top-1 against the hard label, "credit" (any option the soft label accepts), chance,
confidence when right/wrong and latency, per source and per rule family. Saved to
`data/dataset/eval-<engine>-<model>-<time>.json`.

| Model | all | model rows | reverse | synthetic | latency |
|---|---|---|---|---|---|
| Laya zero-shot (2026-09-29) | 0.27 | 0.46 | 0.14 | 0.35 | |
| Jev (400 reverse + synthetic) | 0.91 | n/a | 0.95 | 0.81 | ~256 ms |
| **Laya v1**, Kaggle eval (3,573 rows) | 0.815 (top-3 0.994, ECE 0.079) | 0.837 | 0.787 | 0.857 | 59 ms |
| **Laya v1**, served, HTTP eval (3,664 rows) | 0.841 | 0.865 | | | |

Jev is weak on `rule:gear` (0.17): it picks the highest-tier weapon regardless of the level
requirement; the synthetic set teaches that.

## 7. A/B in game

Offline accuracy is not the goal; in-game success is. Run each activity twice, once per engine,
in one campaign (`data/campaign/ab-laya-v1-2026-10-05.json`: every activity duplicated as
`<name>@jev` / `<name>@laya` with `--engine`):

```bash
# laya server running (step 5), then:
npm run campaign -- --config data/campaign/ab-laya-v1-2026-10-05.json --hours 6 --restart-client
```

Compare per engine: failed-action rate and latency from `logs/agent/*/steps.jsonl`
(`engine` field, `outcome.success`), and activity outcomes from `summary.jsonl`.

v1 A/B (2026-10-05, 07:30-13:30): Laya 910 decisions, 11.2% failed actions, 61 ms; Jev 530,
9.5%, 256 ms. Activity level 5/12 vs 4/8 ran to time. Failures were mostly environmental (no
coins, food, runes), so no clear winner.

## When to retrain

Decision (2026-10-05): train v2 only after an A/B shows Laya holding up in game **and** there is a
much larger batch of Jev data (v1 had ~5k model rows; 10.8k on 2026-10-07). Before retraining,
check that the new data covers the weak spots of the last A/B (see coverage in
[DATA_GATHERING.md](DATA_GATHERING.md#coverage-what-to-gather-next)).
