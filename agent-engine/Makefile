# Agent-engine command launcher. Run `make help`, or use the wrappers (scripts/linux/make-*):
#   make-gold --help   make-agent --help   make-data-gathering --help   make-laya --help   make-dev --help
# Install the wrappers once:  make dev-install-cli
SHELL := /bin/bash
ENGINE := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
HOME_DIR := $(HOME)

# CHAR=1|2 picks the character for agent-*/data-* targets (checkout, agent-server port, token).
CHAR ?= 1
ifeq ($(CHAR),2)
  CHAR_ROOT := $(HOME_DIR)/projects/Microbot_-char2
  CHAR_ENV  := MICROBOT_PORT=8082 MICROBOT_TOKEN_FILE=$(HOME_DIR)/.microbot-char2-home/.runelite/.agent-token
  CHAR_WORLD := 302
else
  CHAR_ROOT := $(HOME_DIR)/projects/Microbot_
  CHAR_ENV  :=
  CHAR_WORLD := 316
endif
CE := $(CHAR_ROOT)/agent-engine
RUN := cd $(CE) && $(CHAR_ENV)
AGENT := $(RUN) npm run -s agent --
LLM ?= --llm claude-code --rescue-model haiku --rescue
WHO ?= both
GOLDRUN := $(ENGINE)/scripts/linux/gold-run
need = $(if $($(1)),,$(error $(1) is required, e.g. make $@ $(1)=$(2)))

.DEFAULT_GOAL := help
.PHONY: help
help: ## show every command (GROUP=gold|agent|data|laya|level|dev for one group)
	@echo "Usage: make <group>-<target> [VAR=value ...]   |   make-<group> <target> [VAR=value ...]"
	@awk -v g="$(GROUP)" 'BEGIN{FS=":.*## "} /^##@ /{split($$0,h," "); cur=h[2]; title=substr($$0,index($$0,"- ")+2); show=(g==""||g==cur); if(show) printf "\n%s\n",title; next} /^##\? /{ if(show) print "  " substr($$0,5); next} show && /^[a-z0-9-]+:.*## /{t=$$1; if(g!="") sub("^" g "-","",t); printf "  %-24s %s\n",t,$$2}' $(MAKEFILE_LIST)
	@echo

##@ gold - Gold runs: campaigns as systemd units (gold-run); WHO=1|2|both
##? vars: WHO=both  HOURS=<h, default until 23:59>  CONFIG=<campaign json, relative to agent-engine/>  PLAN=<plans/x.json>  ARGS=<extra campaign flags>
.PHONY: gold-start gold-plan gold-crafting gold-herblore gold-smelt gold-dry-run gold-status gold-logs gold-stop gold-rebuild-char2
gold-start: ## start the default gold campaign (char1 smelt, char2 herblore); WHO=1|2|both
	$(if $(CONFIG),CHAR1_CONFIG=$(CONFIG) CHAR2_CONFIG=$(CONFIG)) $(GOLDRUN) start $(WHO) $(if $(HOURS),--hours $(HOURS)) $(if $(or $(PLAN),$(ARGS)),-- $(if $(PLAN),--plan $(PLAN)) $(ARGS))
gold-plan: ## run a skill plan on a character; PLAN=plans/gold-1-hunter.json WHO=2
	$(call need,PLAN,plans/gold-1-hunter.json)
	$(GOLDRUN) start $(if $(filter both,$(WHO)),2,$(WHO)) $(if $(HOURS),--hours $(HOURS)) -- --plan $(PLAN) $(ARGS)
gold-crafting: ## char1 craft-jewellery + tan-hides rotation
	CHAR1_CONFIG=data/campaign/char1-crafting.json $(GOLDRUN) start 1 $(if $(HOURS),--hours $(HOURS))
gold-herblore: ## char2 herblore campaign
	CHAR2_CONFIG=data/campaign/char2-herblore.json $(GOLDRUN) start 2 $(if $(HOURS),--hours $(HOURS))
gold-smelt: ## char1 smelt-steel campaign
	CHAR1_CONFIG=data/campaign/smelt-2026-10-06.json $(GOLDRUN) start 1 $(if $(HOURS),--hours $(HOURS))
gold-dry-run: ## show the campaign rotation without running it
	$(GOLDRUN) start $(WHO) -- --dry-run $(if $(PLAN),--plan $(PLAN))
gold-status: ## unit state, current activity, rescues, gp/h, alerts
	$(GOLDRUN) status $(WHO)
gold-logs: ## follow the journal of one character (WHO=1|2)
	$(GOLDRUN) logs $(if $(filter both,$(WHO)),1,$(WHO))
gold-stop: ## end the running activity and stop the client(s)
	$(GOLDRUN) stop $(WHO)
gold-rebuild-char2: ## merge feat/agent-engine into feat/char2 and rebuild its shaded jar
	$(GOLDRUN) rebuild-char2

##@ agent - Look at and run the agent by hand (CHAR=1|2 picks the character)
##? vars: CHAR=1  PLAN=<plan json>  OPTION=<gold option>  TASK=<preset>  STRATEGY=level|money|gold|quest  HOURS=  ARGS=<extra flags>
.PHONY: agent-state agent-skills agent-inventory agent-strategy agent-flow agent-presets agent-prereq agent-plan-show agent-monitor agent-llm-report agent-run-flow agent-run-strategy agent-run-plan agent-run-task agent-campaign-plan
agent-state: ## live client state (position, login)
	cd $(CHAR_ROOT) && $(CHAR_ENV) ./microbot-cli state
agent-skills: ## skill levels
	cd $(CHAR_ROOT) && $(CHAR_ENV) ./microbot-cli skills
agent-inventory: ## inventory
	cd $(CHAR_ROOT) && $(CHAR_ENV) ./microbot-cli inventory
agent-strategy: ## account profile + next phase per strategy (dry run)
	$(AGENT) strategy
agent-flow: ## gold option tree for the logged-in account
	$(AGENT) flow gold
agent-presets: ## list scripted tasks
	$(AGENT) presets
agent-prereq: ## what a task needs first; TASK=kill-barbarians
	$(call need,TASK,kill-barbarians)
	$(AGENT) prereq --task $(TASK)
agent-plan-show: ## roadmap of a plan for the logged-in account; PLAN=plans/gold-1-hunter.json
	$(call need,PLAN,plans/gold-1-hunter.json)
	$(AGENT) plan show $(PLAN) $(ARGS)
agent-monitor: ## running campaign: activity, rescues, gold, alerts
	$(AGENT) monitor $(if $(HOURS),--hours $(HOURS))
agent-llm-report: ## LLM use and rescue success for a plan; PLAN=
	$(call need,PLAN,plans/gold-1-hunter.json)
	$(AGENT) llm-report --plan $(PLAN)
agent-run-flow: ## run one gold option strictly; OPTION=craft-jewellery
	$(call need,OPTION,craft-jewellery)
	$(AGENT) run --flow gold --option $(OPTION) $(LLM) $(ARGS)
agent-run-strategy: ## run a strategy; STRATEGY=gold (default)
	$(AGENT) run --strategy $(or $(STRATEGY),gold) $(LLM) $(ARGS)
agent-run-plan: ## run a plan against the logged-in client; PLAN=
	$(call need,PLAN,plans/gold-1-hunter.json)
	$(AGENT) run --plan $(PLAN) $(LLM) $(ARGS)
agent-run-task: ## run a scripted task preset; TASK=kill-barbarians
	$(call need,TASK,kill-barbarians)
	$(AGENT) run --task $(TASK) $(LLM) $(ARGS)
agent-campaign-plan: ## foreground campaign for a plan (starts the client); PLAN= HOURS=6
	$(call need,PLAN,plans/gold-1-hunter.json)
	$(RUN) npm run campaign -- --plan $(PLAN) --hours $(or $(HOURS),6) --restart-client --world $(CHAR_WORLD) $(LLM) $(ARGS)

##@ data - Data gathering: unattended sessions and the Laya dataset
##? vars: HOURS=3  ONLY=<activity,...>  CHAR=1|2  ARGS=<extra campaign flags>
.PHONY: data-session data-campaign data-dry-run data-monitor data-logs data-dataset data-export data-reverse data-synth data-stats
data-session: ## one full unattended session: refresh login, campaign, stop client, rebuild dataset
	MICROBOT_CAMPAIGN_HOURS=$(or $(HOURS),3) $(ENGINE)/scripts/linux/microbot-campaign $(if $(ONLY),--only $(ONLY)) $(ARGS)
data-campaign: ## foreground campaign rotation (client must be running or --restart-client)
	$(RUN) npm run campaign -- --hours $(or $(HOURS),3) --world $(CHAR_WORLD) --restart-client $(if $(ONLY),--only $(ONLY)) $(ARGS)
data-dry-run: ## show the rotation, run nothing
	$(RUN) npm run campaign -- --dry-run $(ARGS)
data-monitor: ## running campaign status
	$(AGENT) monitor $(if $(HOURS),--hours $(HOURS))
data-logs: ## tail the latest campaign log
	$(RUN) tail -f logs/campaign/$$(ls logs/campaign | tail -1)/campaign.log
data-dataset: ## build train/eval from all sources
	$(RUN) npm run dataset:build
data-export: ## only logged decisions
	$(RUN) npm run dataset:export
data-reverse: ## only reverse-generated samples
	$(RUN) npm run dataset:reverse
data-synth: ## only rule-labelled samples
	$(RUN) npm run dataset:synth
data-stats: ## dataset mix stats
	cat $(CE)/data/dataset/mix-stats.json

##@ laya - Laya fine-tuning, serving and eval
##? vars: CHECKPOINT=~/laya_models/laya-osrs-agent-v1  MODEL=osrs-v1  LIMIT=500
.PHONY: laya-freeze laya-serve laya-eval laya-teacher-eval laya-kaggle-version laya-kernel-status
laya-freeze: ## snapshot dataset + step logs into data/dataset/<date>/
	$(RUN) bash -c 'B=data/dataset/$$(date +%F); mkdir -p $$B && cp data/dataset/{train,eval}.jsonl data/dataset/mix-stats.json $$B/ && tar -czf $$B/step-logs.tar.gz logs/agent && echo frozen $$B'
laya-serve: ## serve a Laya checkpoint on 127.0.0.1:8000 (CUDA)
	LAYA_CHECKPOINT=$(or $(CHECKPOINT),$(HOME)/laya_models/laya-osrs-agent-v1) $(HOME)/projects/laya/.venv/bin/python $(HOME)/laya_models/serve_osrs.py
laya-eval: ## eval the served Laya model on eval.jsonl
	$(RUN) npm run dataset:eval -- --engine laya --model $(or $(MODEL),osrs-v1) $(if $(LIMIT),--limit $(LIMIT)) $(ARGS)
laya-teacher-eval: ## Jev ceiling on eval.jsonl (costs API calls)
	$(RUN) npm run dataset:eval -- --engine jev --limit $(or $(LIMIT),400)
laya-kaggle-version: ## push train/eval as a new Kaggle dataset version
	$(RUN) bash -c 'D=$$(mktemp -d); cp data/dataset/{train,eval}.jsonl $$D/; kaggle datasets metadata <kaggle-user>/osrs-agent-decisions-v1 -p $$D && kaggle datasets version -p $$D -m "$$(date +%F): $$(jq -c .train data/dataset/mix-stats.json)"'
laya-kernel-status: ## status of the fine-tune kernel
	kaggle kernels status <kaggle-user>/laya-osrs-agent-finetune

##@ level - Level skills, free or paid: the account's membership decides which methods are used
##? vars: TO=<target level, default: finish the method bracket>  CHAR=1|2  ARGS=<extra flags>  (LLM flags as in agent-*)
##? list what exists first:  make-level list [SKILL=Fishing] [MEMBERS=f2p]   (script = scripted, llm = LLM-driven)
.PHONY: level-list level-lowest level-quests level-skill level-attack level-strength level-defence level-hitpoints level-melee level-ranged level-magic level-prayer level-slayer level-cooking level-woodcutting level-fishing level-firemaking level-crafting level-smithing level-mining level-herblore level-agility level-thieving level-fletching level-farming level-runecraft level-hunter level-construction
level-list: ## training methods per skill from the catalog; SKILL=Agility MEMBERS=f2p to filter
	cd $(ENGINE) && node --disable-warning=ExperimentalWarning scripts/training-list.ts $(SKILL) $(MEMBERS)
level-lowest: ## train whichever trainable skill is lowest, bracket by bracket
	$(AGENT) run --strategy level $(LLM) $(ARGS)
level-quests: ## do the next unfinished quest in the recommended order
	$(AGENT) run --strategy quest $(LLM) $(ARGS)
level-skill: ## any skill by name; SKILL=Fishing TO=40
	$(call need,SKILL,Fishing)
	$(AGENT) run --strategy level --skill $(SKILL) $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-attack: ## Attack: melee, via the best melee spot for your stats
	$(AGENT) run --strategy level --skill Attack $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-strength: ## Strength: melee
	$(AGENT) run --strategy level --skill Strength $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-defence: ## Defence: melee
	$(AGENT) run --strategy level --skill Defence $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-hitpoints: ## Hitpoints: melee
	$(AGENT) run --strategy level --skill Hitpoints $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-melee: ## Melee: all melee stats (Attack/Strength/Defence/HP) at the best spot
	$(AGENT) run --strategy level --skill Melee $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-ranged: ## Ranged: cows with a shortbow, then sand crabs (P2P)
	$(AGENT) run --strategy level --skill Ranged $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-magic: ## Magic: Wind Strike on chickens, sand crabs (P2P), High Alchemy 55+
	$(AGENT) run --strategy level --skill Magic $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-prayer: ## Prayer: bury bones from combat
	$(AGENT) run --strategy level --skill Prayer $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-slayer: ## Slayer: tasks from the best master (P2P)
	$(AGENT) run --strategy level --skill Slayer $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-cooking: ## Cooking: shrimps then trout/salmon on fires
	$(AGENT) run --strategy level --skill Cooking $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-woodcutting: ## Woodcutting: trees, oaks, willows
	$(AGENT) run --strategy level --skill Woodcutting $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-fishing: ## Fishing: shrimps, fly fishing, lobsters; barbarian fishing (P2P)
	$(AGENT) run --strategy level --skill Fishing $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-firemaking: ## Firemaking: burn banked logs
	$(AGENT) run --strategy level --skill Firemaking $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-crafting: ## Crafting: quests then jewellery for sale
	$(AGENT) run --strategy level --skill Crafting $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-smithing: ## Smithing: bronze/iron gear, steel bars
	$(AGENT) run --strategy level --skill Smithing $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-mining: ## Mining: copper/tin then iron
	$(AGENT) run --strategy level --skill Mining $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-herblore: ## Herblore: clean herbs and mix potions (P2P)
	$(AGENT) run --strategy level --skill Herblore $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-agility: ## Agility: rooftop courses (P2P)
	$(AGENT) run --strategy level --skill Agility $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-thieving: ## Thieving: men, Al Kharid warriors, Ardougne knights (P2P)
	$(AGENT) run --strategy level --skill Thieving $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-fletching: ## Fletching: arrow shafts, bows, stringing
	$(AGENT) run --strategy level --skill Fletching $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-farming: ## Farming: herb and allotment runs (P2P)
	$(AGENT) run --strategy level --skill Farming $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-runecraft: ## Runecraft: essence to runes, Guardians of the Rift (P2P)
	$(AGENT) run --strategy level --skill Runecraft $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-hunter: ## Hunter: bird snares, butterflies (P2P)
	$(AGENT) run --strategy level --skill Hunter $(if $(TO),--level $(TO)) $(LLM) $(ARGS)
level-construction: ## Construction: Mahogany Homes (P2P)
	$(AGENT) run --strategy level --skill Construction $(if $(TO),--level $(TO)) $(LLM) $(ARGS)

##@ dev - Build, test and set up
.PHONY: dev-typecheck dev-test dev-install-cli dev-kb-build dev-live-jev
dev-typecheck: ## tsc
	cd $(ENGINE) && npm run -s typecheck
dev-test: ## unit tests
	cd $(ENGINE) && npm test
dev-kb-build: ## rebuild the knowledge base sqlite
	cd $(ENGINE) && npm run -s kb:build
dev-live-jev: ## live Jev API test (needs JEV_API_KEY)
	cd $(ENGINE) && npm run -s test:live-jev
dev-install-cli: ## symlink make-gold/-agent/-data-gathering/-laya/-level/-dev and the launchers into ~/.local/bin
	mkdir -p $(HOME)/.local/bin
	for n in make-gold make-agent make-data-gathering make-laya make-level make-dev; do ln -sf $(ENGINE)/scripts/linux/make-agent $(HOME)/.local/bin/$$n; done
	@echo installed; echo "try: make-agent --help"
