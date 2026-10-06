package net.runelite.client.plugins.microbot.agentserver.handler;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import lombok.extern.slf4j.Slf4j;
import net.runelite.api.Client;
import net.runelite.api.EquipmentInventorySlot;
import net.runelite.api.coords.WorldPoint;
import net.runelite.client.plugins.microbot.Microbot;
import net.runelite.client.plugins.microbot.agentserver.AgentTrade;
import net.runelite.client.plugins.microbot.agentserver.AgentWidgets;
import net.runelite.client.plugins.microbot.api.npc.models.Rs2NpcModel;
import net.runelite.client.plugins.microbot.api.tileitem.models.Rs2TileItemModel;
import net.runelite.client.plugins.microbot.api.tileobject.models.Rs2TileObjectModel;
import net.runelite.client.plugins.microbot.util.bank.Rs2Bank;
import net.runelite.client.plugins.microbot.util.combat.Rs2Combat;
import net.runelite.client.plugins.microbot.util.tabs.Rs2Tab;
import net.runelite.client.plugins.microbot.globval.enums.InterfaceTab;
import net.runelite.client.plugins.microbot.util.magic.Rs2CombatSpells;
import net.runelite.client.plugins.microbot.util.magic.Rs2Magic;
import net.runelite.api.widgets.WidgetInfo;
import net.runelite.client.plugins.microbot.util.dialogues.Rs2Dialogue;
import net.runelite.client.plugins.microbot.util.equipment.Rs2Equipment;
import net.runelite.client.plugins.microbot.util.inventory.Rs2Inventory;
import net.runelite.client.plugins.microbot.util.inventory.Rs2ItemModel;
import net.runelite.client.plugins.microbot.util.keyboard.Rs2Keyboard;
import net.runelite.client.plugins.microbot.util.player.Rs2Player;
import net.runelite.client.plugins.microbot.util.grandexchange.Rs2GrandExchange;
import net.runelite.client.plugins.microbot.util.shop.Rs2Shop;
import net.runelite.api.gameval.InterfaceID;
import net.runelite.client.plugins.microbot.util.widget.Rs2Widget;

import java.io.IOException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

import static net.runelite.client.plugins.microbot.util.Global.sleepUntil;

/**
 * {@code POST /act}: one structured action per request, addressed at an exact entity instance.
 * <p>
 * The legacy per-entity endpoints ({@code /npcs/interact}, {@code /objects/interact}) resolve targets
 * by name and pick the nearest match, which is not necessarily the instance an agent chose. Here
 * NPCs are addressed by client index, objects and ground items by id + tile, inventory items by slot.
 * Every action goes through Microbot's normal interaction helpers (menu entry + synthetic click).
 * <p>
 * Body: {@code {"op": "...", ...}} with ops
 * {@code interact, use_item_on, walk, walk_cancel, dialogue_continue, dialogue_select,
 * production_select, bank_open, bank_close, bank_deposit_all, bank_deposit, bank_withdraw, drop,
 * toggle_run, attack_style, autocast, shop_*, ge_*, tab_open, widget_click, type_text, cast_on}. See {@code agent-engine/src/types.ts} for the field shapes.
 * <p>
 * The response only reports whether the interaction was dispatched ({@code success}) or why it could
 * not be ({@code reason}); callers verify effects from the next {@code /snapshot}.
 */
@Slf4j
public class ActHandler extends AgentHandler {

	/** Combat tab style buttons, left to right, top to bottom. */
	@SuppressWarnings("deprecation")
	private static final WidgetInfo[] COMBAT_STYLES = {
		WidgetInfo.COMBAT_STYLE_ONE, WidgetInfo.COMBAT_STYLE_TWO, WidgetInfo.COMBAT_STYLE_THREE, WidgetInfo.COMBAT_STYLE_FOUR
	};

	static final Set<String> OPS = new HashSet<>(Arrays.asList(
			"interact", "use_item_on", "walk", "walk_cancel", "dialogue_continue", "dialogue_select",
			"production_select", "bank_open", "bank_close", "bank_deposit_all", "bank_deposit", "bank_withdraw",
			"drop", "toggle_run", "attack_style", "autocast", "shop_buy", "shop_close", "ge_buy", "ge_sell", "ge_collect", "ge_close",
			"tab_open", "widget_click", "type_text", "cast_on",
			"trade_player", "trade_offer", "trade_accept", "trade_decline"));

	/** Longest text {@code type_text} accepts (display names are at most 12 characters). */
	private static final int MAX_TYPED = 32;

	private final Client client;

	public ActHandler(Gson gson, Client client) {
		super(gson);
		this.client = client;
	}

	@Override
	public String getPath() {
		return "/act";
	}

	@Override
	protected void handleRequest(HttpExchange exchange) throws IOException {
		try {
			requirePost(exchange);
		} catch (HttpMethodException e) {
			sendJson(exchange, 405, errorResponse(e.getMessage()));
			return;
		}

		Map<String, Object> body;
		try {
			body = readJsonBody(exchange);
		} catch (Exception e) {
			sendJson(exchange, 400, errorResponse("Invalid JSON body"));
			return;
		}
		if (body == null || !(body.get("op") instanceof String)) {
			sendJson(exchange, 400, errorResponse("Missing required field: op"));
			return;
		}

		String op = (String) body.get("op");
		if (!OPS.contains(op)) {
			sendJson(exchange, 400, errorResponse("Unknown op: " + op));
			return;
		}
		Result result;
		if (!Microbot.isLoggedIn()) {
			result = Result.fail("not_logged_in");
		} else {
			try {
				result = dispatch(op, body);
			} catch (IllegalArgumentException e) {
				sendJson(exchange, 400, errorResponse(e.getMessage()));
				return;
			}
		}

		Map<String, Object> response = new LinkedHashMap<>();
		response.put("success", result.success);
		response.put("op", op);
		response.put("tick", client.getTickCount());
		if (result.reason != null) {
			response.put("reason", result.reason);
		}
		sendJson(exchange, 200, response);
	}

	private Result dispatch(String op, Map<String, Object> body) {
		switch (op) {
			case "interact":
				return interact(requireMap(body, "target"), requireString(body, "action"));
			case "use_item_on":
				return useItemOn(requireInt(body, "itemSlot"), requireMap(body, "target"));
			case "walk": {
				Map<String, Object> to = requireMap(body, "to");
				WorldPoint dest = new WorldPoint(requireInt(to, "x"), requireInt(to, "y"), optInt(to, "plane", 0));
				WalkHandler.submitWalk(dest, optInt(body, "distance", 1));
				return Result.ok();
			}
			case "walk_cancel":
				return WalkHandler.cancelActiveWalk() ? Result.ok() : Result.fail("no_active_walk");
			case "dialogue_continue":
				if (!Rs2Dialogue.hasContinue()) return Result.fail("no_continue");
				Rs2Dialogue.clickContinue();
				return Result.ok();
			case "dialogue_select":
				return Rs2Dialogue.clickOption(requireString(body, "option"), false) ? Result.ok() : Result.fail("option_not_found");
			case "production_select": {
				String option = requireString(body, "option");
				if (AgentWidgets.isSmithingOpen()) {
					Object amount = body.get("amount");
					String quantity = amount instanceof Number ? String.valueOf(((Number) amount).intValue()) : "All";
					return AgentWidgets.smith(client, option, quantity) ? Result.ok() : Result.fail("option_not_found");
				}
				// The tanner always tans every carried hide of that leather ("Tan All").
				if (AgentWidgets.isTanningOpen()) return AgentWidgets.tanAll(client, option) ? Result.ok() : Result.fail("option_not_found");
				if (!Rs2Widget.isProductionWidgetOpen()) return Result.fail("production_not_open");
				return Rs2Widget.handleProcessingInterface(option) ? Result.ok() : Result.fail("option_not_found");
			}
			case "shop_buy": {
				if (!Rs2Shop.isOpen()) return Result.fail("shop_not_open");
				int amount = optInt(body, "amount", 1);
				if (amount != 1 && amount != 5 && amount != 10 && amount != 50) {
					throw new IllegalArgumentException("amount must be 1, 5, 10 or 50 (the shop's Buy options)");
				}
				int itemId = requireInt(body, "itemId");
				if (!Rs2Shop.hasStock(itemId)) return Result.fail("out_of_stock");
				return Rs2Shop.buyItem(itemId, String.valueOf(amount)) ? Result.ok() : Result.fail("buy_failed");
			}
			case "shop_close":
				if (!Rs2Shop.isOpen()) return Result.fail("shop_not_open");
				Rs2Shop.closeShop();
				return Result.ok();
			case "ge_buy": {
				// Buy offer at the guide price +30% (min 5 gp), so low-volume quest items fill at once,
				// then collect the items into the inventory.
				if (!Rs2GrandExchange.isOpen()) return Result.fail("ge_not_open");
				String name = requireString(body, "name");
				int quantity = Math.max(1, optInt(body, "quantity", 1));
				int guide = Microbot.getRs2ItemManager().getGEPrice(name);
				if (guide <= 0) return Result.fail("no_ge_price");
				int price = Math.max(5, (int) Math.ceil(guide * 1.3));
				int coins = Rs2Inventory.itemQuantity("Coins");
				if (coins < price * quantity) return Result.fail("not_enough_coins (need " + (price * quantity) + ", have " + coins + ")");
				// Finished offers hold their slot until collected; free accounts have three.
				if (Rs2GrandExchange.getAvailableSlots().length == 0) Rs2GrandExchange.collectAllToInventory();
				// Still full: stale offers placed by earlier runs that never filled. Abort them (the
				// coins come back) rather than block every later purchase.
				if (Rs2GrandExchange.getAvailableSlots().length == 0) Rs2GrandExchange.abortAllOffers(false);
				if (Rs2GrandExchange.getAvailableSlots().length == 0) return Result.fail("no_free_ge_slot");
				// A setup screen left by an earlier failed offer hides the slot buttons and keeps its
				// search text, so every later offer would fail too.
				if (Rs2GrandExchange.isOfferScreenOpen()) Rs2GrandExchange.backToOverview();
				if (!Rs2GrandExchange.buyItem(name, price, quantity)) {
					Rs2GrandExchange.backToOverview();
					return Result.fail("offer_failed (item search or price entry did not complete)");
				}
				sleepUntil(Rs2GrandExchange::hasBoughtOffer, 10_000);
				Rs2GrandExchange.collectAllToInventory();
				return Result.ok();
			}
			case "ge_sell": {
				// Sell offer at 70% of the guide price so it fills at once, then collect the coins.
				// Sells the carried items (noted or not) of that name; quantity defaults to all of them.
				if (!Rs2GrandExchange.isOpen()) return Result.fail("ge_not_open");
				String name = requireString(body, "name");
				int held = Rs2Inventory.itemQuantity(name);
				if (held <= 0) return Result.fail("item_not_in_inventory");
				int quantity = Math.min(held, Math.max(1, optInt(body, "quantity", held)));
				int guide = Microbot.getRs2ItemManager().getGEPrice(name);
				if (guide <= 0) return Result.fail("no_ge_price");
				int price = Math.max(1, (int) Math.floor(guide * 0.7));
				if (Rs2GrandExchange.getAvailableSlots().length == 0) Rs2GrandExchange.collectAllToInventory();
				if (Rs2GrandExchange.getAvailableSlots().length == 0) return Result.fail("no_free_ge_slot");
				if (Rs2GrandExchange.isOfferScreenOpen()) Rs2GrandExchange.backToOverview();
				if (!Rs2GrandExchange.sellItem(name, quantity, price)) {
					Rs2GrandExchange.backToOverview();
					return Result.fail("offer_failed (item selection or price entry did not complete)");
				}
				sleepUntil(Rs2GrandExchange::hasSoldOffer, 10_000);
				Rs2GrandExchange.collectAllToInventory();
				return Result.ok();
			}
			case "ge_collect":
				if (!Rs2GrandExchange.isOpen()) return Result.fail("ge_not_open");
				return Rs2GrandExchange.collectAllToInventory() ? Result.ok() : Result.fail("nothing_to_collect");
			case "ge_close":
				if (!Rs2GrandExchange.isOpen()) return Result.fail("ge_not_open");
				Rs2GrandExchange.closeExchange();
				return Result.ok();
			case "bank_open":
				if (Rs2Bank.isOpen()) return Result.ok();
				return Rs2Bank.openBank() ? Result.ok() : Result.fail("no_bank_nearby");
			case "bank_close":
				return Rs2Bank.closeBank() ? Result.ok() : Result.fail("bank_not_open");
			case "bank_deposit_all":
				if (!Rs2Bank.isOpen()) return Result.fail("bank_not_open");
				return Rs2Bank.depositAll() ? Result.ok() : Result.fail("deposit_failed");
			case "bank_deposit":
				return bankTransfer(true, requireInt(body, "itemId"), body.get("amount"));
			case "bank_withdraw": {
				// Noted withdraws carry a whole stack of products to the Grand Exchange in one slot.
				if (Rs2Bank.isOpen()) {
					boolean noted = Boolean.TRUE.equals(body.get("noted"));
					if (Rs2Bank.hasWithdrawAsNote() != noted) {
						// The Note button toggles both ways (Rs2Bank.setWithdrawAsItem clicks another widget).
						Rs2Widget.clickWidget(InterfaceID.Bankmain.NOTE);
						if (!sleepUntil(() -> Rs2Bank.hasWithdrawAsNote() == noted, 2_000)) return Result.fail("note_toggle_failed");
					}
				}
				return bankTransfer(false, requireInt(body, "itemId"), body.get("amount"));
			}
			case "drop": {
				Rs2ItemModel item = Rs2Inventory.getItemInSlot(requireInt(body, "slot"));
				if (item == null) return Result.fail("slot_empty");
				return Rs2Inventory.interact(item, "Drop") ? Result.ok() : Result.fail("drop_failed");
			}
			case "toggle_run":
				return Rs2Player.toggleRunEnergy(Boolean.TRUE.equals(body.get("enabled"))) ? Result.ok() : Result.fail("toggle_failed");
			case "attack_style": {
				int index = requireInt(body, "index");
				if (index < 0 || index >= COMBAT_STYLES.length) throw new IllegalArgumentException("index must be 0-3");
				if (client.getVarpValue(43) == index) return Result.ok();
				// The style buttons only take clicks while the combat tab is showing.
				Rs2Tab.switchTo(InterfaceTab.COMBAT);
				if (!sleepUntil(() -> Rs2Tab.getCurrentTab() == InterfaceTab.COMBAT, 2_000)) return Result.fail("combat_tab_not_open");
				boolean clicked = Rs2Combat.setAttackStyle(COMBAT_STYLES[index]);
				boolean changed = clicked && sleepUntil(() -> client.getVarpValue(43) == index, 2_000);
				Rs2Tab.switchTo(InterfaceTab.INVENTORY);
				return changed ? Result.ok() : Result.fail("style_not_available");
			}
			case "autocast": {
				Rs2CombatSpells spell;
				try {
					spell = Rs2CombatSpells.valueOf(requireString(body, "spell"));
				} catch (IllegalArgumentException e) {
					throw new IllegalArgumentException("Unknown combat spell: " + body.get("spell"));
				}
				// Needs a staff that can autocast, the magic level and the runes.
				return Rs2Combat.setAutoCastSpell(spell, Boolean.TRUE.equals(body.get("defensive"))) ? Result.ok() : Result.fail("cannot_autocast");
			}
			case "cast_on": {
				// Select a combat spell, then click the NPC with it (Tutorial Island's Wind Strike, no staff).
				Rs2CombatSpells spell;
				try {
					spell = Rs2CombatSpells.valueOf(requireString(body, "spell"));
				} catch (IllegalArgumentException e) {
					throw new IllegalArgumentException("Unknown combat spell: " + body.get("spell"));
				}
				Rs2NpcModel npc = findNpc(requireMap(body, "target"));
				if (npc == null) return Result.fail("target_not_found");
				if (!Rs2Magic.cast(spell)) return Result.fail("cannot_cast");
				if (!sleepUntil(() -> Microbot.getClientThread().runOnClientThreadOptional(client::isWidgetSelected).orElse(false), 2_000)) return Result.fail("spell_not_selected");
				return npc.click("Cast") ? Result.ok() : Result.fail("click_failed");
			}
			case "tab_open": {
				// Tutorial Island guides wait for a side tab to be opened (settings, inventory, skills...).
				InterfaceTab tab;
				try {
					tab = InterfaceTab.valueOf(requireString(body, "tab"));
				} catch (IllegalArgumentException e) {
					throw new IllegalArgumentException("Unknown tab: " + body.get("tab"));
				}
				if (Rs2Tab.getCurrentTab() == tab) return Result.ok();
				Rs2Tab.switchTo(tab);
				return sleepUntil(() -> Rs2Tab.getCurrentTab() == tab, 2_000) ? Result.ok() : Result.fail("tab_not_opened");
			}
			case "trade_player": {
				// Only the player the caller names (the account's own other character).
				String name = requireString(body, "name");
				return AgentTrade.tradePlayer(client, name) ? Result.ok() : Result.fail("player_not_found");
			}
			case "trade_offer": {
				if (AgentTrade.stage() == null) return Result.fail("trade_not_open");
				String name = requireString(body, "name");
				String option = body.get("option") instanceof String ? (String) body.get("option") : "Offer-All";
				return AgentTrade.offer(client, name, option) ? Result.ok() : Result.fail("item_not_offered");
			}
			case "trade_accept":
				return AgentTrade.accept() ? Result.ok() : Result.fail("trade_not_open");
			case "trade_decline":
				return AgentTrade.decline() ? Result.ok() : Result.fail("trade_not_open");
			case "widget_click": {
				// Buttons on interfaces with no world target: character design "Confirm", name lookup, etc.
				String text = requireString(body, "text");
				boolean exact = Boolean.TRUE.equals(body.get("exact"));
				if (!Rs2Widget.hasWidget(text)) return Result.fail("widget_not_found");
				return Rs2Widget.clickWidget(text, exact) ? Result.ok() : Result.fail("click_failed");
			}
			case "type_text": {
				String text = requireString(body, "text");
				if (text.isEmpty() || text.length() > MAX_TYPED) throw new IllegalArgumentException("text must be 1-" + MAX_TYPED + " characters");
				Rs2Keyboard.typeString(text);
				if (Boolean.TRUE.equals(body.get("enter"))) Rs2Keyboard.enter();
				return Result.ok();
			}
			default:
				throw new IllegalArgumentException("Unknown op: " + op);
		}
	}

	private Result interact(Map<String, Object> target, String action) {
		String kind = requireString(target, "kind");
		switch (kind) {
			case "npc": {
				Rs2NpcModel npc = findNpc(target);
				if (npc == null) return Result.fail("target_not_found");
				return npc.click(action) ? Result.ok() : Result.fail("click_failed");
			}
			case "object": {
				Rs2TileObjectModel obj = findObject(target);
				if (obj == null) return Result.fail("target_not_found");
				return obj.click(action) ? Result.ok() : Result.fail("click_failed");
			}
			case "ground_item": {
				if (!"Take".equalsIgnoreCase(action)) return Result.fail("unsupported_action");
				Rs2TileItemModel item = findGroundItem(target);
				if (item == null) return Result.fail("target_not_found");
				return item.pickup() ? Result.ok() : Result.fail("click_failed");
			}
			case "inventory": {
				Rs2ItemModel item = findInventoryItem(target);
				if (item == null) return Result.fail("slot_changed");
				return Rs2Inventory.interact(item, action) ? Result.ok() : Result.fail("click_failed");
			}
			case "equipment": {
				EquipmentInventorySlot slot;
				try {
					slot = EquipmentInventorySlot.valueOf(requireString(target, "slot"));
				} catch (IllegalArgumentException e) {
					throw new IllegalArgumentException("Unknown equipment slot: " + target.get("slot"));
				}
				if (Rs2Equipment.get(slot) == null) return Result.fail("slot_empty");
				return Rs2Equipment.interact(slot, action) ? Result.ok() : Result.fail("click_failed");
			}
			case "dialogue":
				return Rs2Dialogue.clickOption(requireString(target, "option"), false) ? Result.ok() : Result.fail("option_not_found");
			default:
				throw new IllegalArgumentException("Unsupported target kind for interact: " + kind);
		}
	}

	private Result useItemOn(int itemSlot, Map<String, Object> target) {
		Rs2ItemModel item = Rs2Inventory.getItemInSlot(itemSlot);
		if (item == null) return Result.fail("slot_empty");
		String kind = requireString(target, "kind");
		switch (kind) {
			case "inventory": {
				Rs2ItemModel other = findInventoryItem(target);
				if (other == null) return Result.fail("slot_changed");
				return Rs2Inventory.combine(item, other) ? Result.ok() : Result.fail("combine_failed");
			}
			case "npc": {
				Rs2NpcModel npc = findNpc(target);
				if (npc == null) return Result.fail("target_not_found");
				if (!selectItem(item)) return Result.fail("select_failed");
				// With an item selected, the click becomes "Use <item> -> <npc>".
				return npc.click("Use") ? Result.ok() : Result.fail("click_failed");
			}
			case "object": {
				Rs2TileObjectModel obj = findObject(target);
				if (obj == null) return Result.fail("target_not_found");
				if (!selectItem(item)) return Result.fail("select_failed");
				return obj.click("Use") ? Result.ok() : Result.fail("click_failed");
			}
			default:
				throw new IllegalArgumentException("Unsupported target kind for use_item_on: " + kind);
		}
	}

	private static boolean selectItem(Rs2ItemModel item) {
		if (Rs2Bank.isOpen()) return false;
		return Rs2Inventory.use(item) && sleepUntil(Rs2Inventory::isItemSelected, 1_000);
	}

	private Result bankTransfer(boolean deposit, int itemId, Object amount) {
		if (!Rs2Bank.isOpen()) return Result.fail("bank_not_open");
		boolean all = amount == null || "all".equals(amount);
		int n = amount instanceof Number ? ((Number) amount).intValue() : -1;
		if (!all && n <= 0) throw new IllegalArgumentException("amount must be a positive number or \"all\"");
		boolean ok;
		if (deposit) {
			if (!Rs2Inventory.hasItem(itemId)) return Result.fail("item_not_in_inventory");
			ok = all ? Rs2Bank.depositAll(itemId) : n == 1 ? Rs2Bank.depositOne(itemId) : Rs2Bank.depositX(itemId, n);
		} else {
			if (!Rs2Bank.hasItem(itemId)) return Result.fail("item_not_in_bank");
			ok = all ? Rs2Bank.withdrawAll(itemId) : n == 1 ? Rs2Bank.withdrawOne(itemId) : Rs2Bank.withdrawX(itemId, n);
		}
		return ok ? Result.ok() : Result.fail(deposit ? "deposit_failed" : "withdraw_failed");
	}

	// --- target resolution: exact instance, never "nearest with this name" --------------------

	private static Rs2NpcModel findNpc(Map<String, Object> target) {
		int index = requireInt(target, "index");
		return Microbot.getRs2NpcCache().query()
				.where(npc -> npc.getIndex() == index)
				.firstOnClientThread();
	}

	private static Rs2TileObjectModel findObject(Map<String, Object> target) {
		int id = requireInt(target, "id");
		WorldPoint at = new WorldPoint(requireInt(target, "x"), requireInt(target, "y"), optInt(target, "plane", 0));
		Rs2TileObjectModel exact = Microbot.getRs2TileObjectCache().query()
				.withId(id)
				.where(obj -> at.equals(obj.getWorldLocation()))
				.firstOnClientThread();
		if (exact != null) return exact;
		// Multi-tile objects can report a different anchor tile than the one the snapshot showed
		// after a scene reload; accept the same id within one tile, never further.
		return Microbot.getRs2TileObjectCache().query()
				.withId(id)
				.where(obj -> obj.getWorldLocation().distanceTo(at) <= 1)
				.nearestOnClientThread();
	}

	private static Rs2TileItemModel findGroundItem(Map<String, Object> target) {
		int id = requireInt(target, "id");
		WorldPoint at = new WorldPoint(requireInt(target, "x"), requireInt(target, "y"), optInt(target, "plane", 0));
		return Microbot.getRs2TileItemCache().query()
				.withId(id)
				.where(item -> at.equals(item.getWorldLocation()))
				.firstOnClientThread();
	}

	/** The item in the given slot, or null when the slot no longer holds the expected item id. */
	private static Rs2ItemModel findInventoryItem(Map<String, Object> target) {
		Rs2ItemModel item = Rs2Inventory.getItemInSlot(requireInt(target, "slot"));
		if (item == null) return null;
		if (target.get("id") instanceof Number && ((Number) target.get("id")).intValue() != item.getId()) return null;
		return item;
	}

	// --- body helpers -------------------------------------------------------------------------

	@SuppressWarnings("unchecked")
	private static Map<String, Object> requireMap(Map<String, Object> body, String key) {
		Object v = body.get(key);
		if (!(v instanceof Map)) throw new IllegalArgumentException("Missing required object field: " + key);
		return (Map<String, Object>) v;
	}

	private static String requireString(Map<String, Object> body, String key) {
		Object v = body.get(key);
		if (!(v instanceof String) || ((String) v).isEmpty()) throw new IllegalArgumentException("Missing required field: " + key);
		return (String) v;
	}

	private static int requireInt(Map<String, Object> body, String key) {
		Object v = body.get(key);
		if (!(v instanceof Number)) throw new IllegalArgumentException("Missing required numeric field: " + key);
		return ((Number) v).intValue();
	}

	private static int optInt(Map<String, Object> body, String key, int dflt) {
		Object v = body.get(key);
		return v instanceof Number ? ((Number) v).intValue() : dflt;
	}

	private static final class Result {
		final boolean success;
		final String reason;

		private Result(boolean success, String reason) {
			this.success = success;
			this.reason = reason;
		}

		static Result ok() {
			return new Result(true, null);
		}

		static Result fail(String reason) {
			return new Result(false, reason);
		}
	}
}
