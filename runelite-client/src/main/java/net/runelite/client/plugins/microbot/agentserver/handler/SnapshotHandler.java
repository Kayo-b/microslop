package net.runelite.client.plugins.microbot.agentserver.handler;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import net.runelite.api.Actor;
import net.runelite.api.Client;
import net.runelite.api.CollisionData;
import net.runelite.api.CollisionDataFlag;
import net.runelite.api.WorldView;
import net.runelite.api.coords.LocalPoint;
import net.runelite.api.EquipmentInventorySlot;
import net.runelite.api.NPC;
import net.runelite.api.NPCComposition;
import net.runelite.api.ObjectComposition;
import net.runelite.api.Player;
import net.runelite.api.Skill;
import net.runelite.api.coords.WorldPoint;
import net.runelite.api.gameval.InterfaceID;
import net.runelite.api.widgets.Widget;
import net.runelite.client.plugins.microbot.Microbot;
import net.runelite.client.plugins.microbot.agentserver.AgentWidgets;
import net.runelite.client.plugins.microbot.agentserver.GameMessageLog;
import net.runelite.client.plugins.microbot.api.npc.models.Rs2NpcModel;
import net.runelite.client.plugins.microbot.api.tileitem.models.Rs2TileItemModel;
import net.runelite.client.plugins.microbot.api.tileobject.models.Rs2TileObjectModel;
import net.runelite.client.plugins.microbot.api.tileobject.models.TileObjectType;
import net.runelite.client.plugins.microbot.util.bank.Rs2Bank;
import net.runelite.client.plugins.microbot.util.dialogues.Rs2Dialogue;
import net.runelite.client.plugins.microbot.util.equipment.Rs2Equipment;
import net.runelite.client.plugins.microbot.util.inventory.Rs2Inventory;
import net.runelite.client.plugins.microbot.util.inventory.Rs2ItemModel;
import net.runelite.client.plugins.microbot.util.misc.Rs2UiHelper;
import net.runelite.client.plugins.microbot.util.player.Rs2Player;
import net.runelite.client.plugins.microbot.util.shop.Rs2Shop;
import net.runelite.client.plugins.microbot.util.tile.Rs2Tile;
import net.runelite.client.plugins.microbot.util.widget.Rs2Widget;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * {@code GET /snapshot}: the whole decision-relevant game state in one response, for agents that
 * decide once per tick instead of polling a dozen endpoints.
 * <p>
 * Query params: {@code radius} (entity search radius, default 15, max 30), {@code maxNpcs} (25),
 * {@code maxObjects} (40), {@code maxGroundItems} (20), {@code bankItems} (100, max 800),
 * {@code messages} (20).
 * <p>
 * Entity lists are read in ONE client-thread pass, and reachability comes from ONE bounded BFS from
 * the player shared by every entity (instead of a BFS per object), so the render thread is held for
 * a single short read. Only interactable objects (with at least one action) are listed.
 */
public class SnapshotHandler extends AgentHandler {

	private static final int DEFAULT_RADIUS = 15;
	private static final int MAX_RADIUS = 30;

	private static final java.util.Set<String> USE_ON_OBJECTS = new java.util.HashSet<>(java.util.Arrays.asList("fire"));

	private final Client client;

	public SnapshotHandler(Gson gson, Client client) {
		super(gson);
		this.client = client;
	}

	@Override
	public String getPath() {
		return "/snapshot";
	}

	@Override
	protected void handleRequest(HttpExchange exchange) throws IOException {
		try {
			requireGet(exchange);
		} catch (HttpMethodException e) {
			sendJson(exchange, 405, errorResponse(e.getMessage()));
			return;
		}

		Map<String, String> params = parseQuery(exchange.getRequestURI());
		int radius = clamp(getIntParam(params, "radius", DEFAULT_RADIUS), 1, MAX_RADIUS);
		int maxNpcs = clamp(getIntParam(params, "maxNpcs", 25), 0, 100);
		int maxObjects = clamp(getIntParam(params, "maxObjects", 40), 0, 200);
		int maxGroundItems = clamp(getIntParam(params, "maxGroundItems", 20), 0, 100);
		int maxBankItems = clamp(getIntParam(params, "bankItems", 100), 0, 800);
		int maxMessages = clamp(getIntParam(params, "messages", 20), 0, 50);

		Map<String, Object> snapshot = new LinkedHashMap<>();
		snapshot.put("tick", client.getTickCount());
		snapshot.put("timestamp", System.currentTimeMillis());
		snapshot.put("loggedIn", Microbot.isLoggedIn());
		snapshot.put("gameState", client.getGameState().name());

		if (!Microbot.isLoggedIn()) {
			snapshot.put("player", null);
			sendJson(exchange, 200, snapshot);
			return;
		}

		Map<String, Object> world = Microbot.getClientThread()
				.runOnClientThreadOptional(() -> readWorldOnClientThread(radius, maxNpcs, maxObjects, maxGroundItems))
				.orElse(null);
		if (world == null) {
			sendJson(exchange, 503, errorResponse("Game state unavailable (client thread read failed)"));
			return;
		}
		snapshot.putAll(world);

		// Item containers and widgets are read from Microbot's caches / widget helpers, which are
		// safe off the client thread (the existing /inventory and /dialogue handlers do the same).
		snapshot.put("inventory", readInventory());
		snapshot.put("equipment", readEquipment());
		snapshot.put("dialogue", readDialogue());
		snapshot.put("production", readProduction());
		snapshot.put("bank", readBank(maxBankItems));
		snapshot.put("shop", readShop());
		snapshot.put("walk", WalkHandler.activeWalkStatus());
		snapshot.put("messages", GameMessageLog.recent(maxMessages));

		sendJson(exchange, 200, snapshot);
	}

	private Map<String, Object> readWorldOnClientThread(int radius, int maxNpcs, int maxObjects, int maxGroundItems) {
		Player local = client.getLocalPlayer();
		if (local == null) {
			return null;
		}
		WorldPoint me = local.getWorldLocation();
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("player", readPlayer(local, me));
		out.put("skills", readSkills());

		// Path distances from the player to every tile within radius (+2 so entities on the edge
		// still get their adjacent tiles evaluated). Missing tile = unreachable.
		Map<WorldPoint, Integer> reach = Rs2Tile.getReachableTilesFromTile(me, radius + 2);

		List<Map<String, Object>> npcs = Microbot.getRs2NpcCache().query().within(radius).toList().stream()
				.map(npc -> serializeNpc(npc, me, reach))
				.filter(m -> m != null)
				.sorted(Comparator.comparingInt(m -> (int) m.get("distance")))
				.limit(maxNpcs)
				.collect(Collectors.toList());
		out.put("npcs", npcs);

		List<Map<String, Object>> objects = Microbot.getRs2TileObjectCache().query().within(radius).toList().stream()
				.map(obj -> serializeObject(obj, me, reach))
				.filter(m -> m != null)
				.sorted(Comparator.comparingInt(m -> (int) m.get("distance")))
				.limit(maxObjects)
				.collect(Collectors.toList());
		out.put("objects", objects);

		List<Map<String, Object>> groundItems = Microbot.getRs2TileItemCache().query().within(radius).toList().stream()
				.map(item -> serializeGroundItem(item, me, reach))
				.filter(m -> m != null)
				.sorted(Comparator.comparingInt(m -> (int) m.get("distance")))
				.limit(maxGroundItems)
				.collect(Collectors.toList());
		out.put("groundItems", groundItems);
		return out;
	}

	private Map<String, Object> readPlayer(Player local, WorldPoint me) {
		Map<String, Object> p = new LinkedHashMap<>();
		p.put("name", local.getName());
		p.put("combatLevel", local.getCombatLevel());
		p.put("position", point(me));
		p.put("hp", pair(client.getBoostedSkillLevel(Skill.HITPOINTS), client.getRealSkillLevel(Skill.HITPOINTS)));
		p.put("prayer", pair(client.getBoostedSkillLevel(Skill.PRAYER), client.getRealSkillLevel(Skill.PRAYER)));
		p.put("runEnergy", client.getEnergy() / 100);
		// Varp 173 = run toggle, 300 = special attack energy (x10).
		p.put("runEnabled", client.getVarpValue(173) == 1);
		// Combat tab: selected style button (varp 43, 0-3) and the modern autocast spell, if any.
		p.put("attackStyle", client.getVarpValue(43));
		int autocast = client.getVarbitValue(net.runelite.api.gameval.VarbitID.AUTOCAST_SPELL);
		String autocastName = null;
		for (net.runelite.client.plugins.microbot.util.magic.Rs2CombatSpells spell : net.runelite.client.plugins.microbot.util.magic.Rs2CombatSpells.values()) {
			if (autocast != 0 && spell.getVarbitValue() == autocast) {
				autocastName = spell.name();
				break;
			}
		}
		p.put("autocast", autocastName);
		p.put("specialAttack", client.getVarpValue(300) / 10);
		p.put("animation", local.getAnimation());
		p.put("animating", local.getAnimation() != -1);
		p.put("moving", local.getPoseAnimation() != local.getIdlePoseAnimation());
		p.put("inCombat", Rs2Player.isInCombat());

		Actor target = local.getInteracting();
		if (target == null) {
			p.put("interacting", null);
		} else {
			Map<String, Object> t = new LinkedHashMap<>();
			if (target instanceof NPC) {
				t.put("type", "npc");
				t.put("index", ((NPC) target).getIndex());
			} else if (target instanceof Player) {
				t.put("type", "player");
				t.put("index", -1);
			} else {
				t.put("type", "other");
				t.put("index", -1);
			}
			t.put("name", target.getName());
			p.put("interacting", t);
		}
		return p;
	}

	private List<Map<String, Object>> readSkills() {
		List<Map<String, Object>> skills = new ArrayList<>();
		for (Skill skill : Skill.values()) {
			if (skill == Skill.OVERALL) continue;
			Map<String, Object> s = new LinkedHashMap<>();
			s.put("name", skill.getName());
			s.put("level", client.getRealSkillLevel(skill));
			s.put("boosted", client.getBoostedSkillLevel(skill));
			s.put("xp", client.getSkillExperience(skill));
			skills.add(s);
		}
		return skills;
	}

	private Map<String, Object> serializeNpc(Rs2NpcModel model, WorldPoint me, Map<WorldPoint, Integer> reach) {
		NPC npc = model.getNpc();
		NPCComposition comp = npc.getTransformedComposition();
		if (comp == null) {
			comp = npc.getComposition();
		}
		if (comp == null || comp.getName() == null || "null".equalsIgnoreCase(comp.getName())) {
			return null;
		}
		WorldPoint loc = npc.getWorldLocation();
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("index", npc.getIndex());
		m.put("id", comp.getId());
		m.put("name", Rs2UiHelper.stripColTags(comp.getName()));
		m.put("combatLevel", comp.getCombatLevel());
		m.put("actions", actions(comp.getActions()));
		m.put("position", point(loc));
		m.put("distance", loc.distanceTo(me));
		m.put("healthRatio", npc.getHealthRatio());
		m.put("healthScale", npc.getHealthScale());
		Actor npcTarget = npc.getInteracting();
		m.put("interactingWithPlayer", npcTarget == client.getLocalPlayer());
		// In single-combat areas an NPC fighting another player cannot be attacked
		// ("Someone else is fighting that.").
		m.put("interactingWithOther", npcTarget instanceof Player && npcTarget != client.getLocalPlayer());
		m.put("animation", npc.getAnimation());
		putReach(m, reach, loc, comp.getSize(), comp.getSize());
		return m;
	}

	private Map<String, Object> serializeObject(Rs2TileObjectModel model, WorldPoint me, Map<WorldPoint, Integer> reach) {
		ObjectComposition comp = client.getObjectDefinition(model.getId());
		if (comp == null) {
			return null;
		}
		if (comp.getImpostorIds() != null) {
			ObjectComposition impostor = comp.getImpostor();
			if (impostor != null) {
				comp = impostor;
			}
		}
		List<String> actions = actions(comp.getActions());
		if (comp.getName() == null || "null".equalsIgnoreCase(comp.getName())) {
			return null;
		}
		// Objects without menu actions are scenery, except ones you "use" items on: a fire has no
		// options, you cook by using raw food on it.
		if (actions.isEmpty() && !USE_ON_OBJECTS.contains(comp.getName().toLowerCase())) {
			return null;
		}
		WorldPoint loc = model.getWorldLocation();
		Map<String, Object> m = new LinkedHashMap<>();
		// The base id is what /act matches on (the cache queries by base id); the impostor's
		// name/actions are what the player currently sees.
		m.put("id", model.getId());
		m.put("name", Rs2UiHelper.stripColTags(comp.getName()));
		m.put("type", model.getTileObjectType().name());
		m.put("actions", actions);
		m.put("position", point(loc));
		m.put("distance", loc.distanceTo(me));
		// A GAME object (spinning wheel, booth, rock) is used from a tile beside it with no wall in
		// between; doors and other WALL objects sit on the wall and work from either side.
		if (model.getTileObjectType() == TileObjectType.GAME) {
			putReachThroughWalls(m, reach, loc, comp.getSizeX(), comp.getSizeY());
		} else {
			putReach(m, reach, loc, comp.getSizeX(), comp.getSizeY());
		}
		return m;
	}

	private Map<String, Object> serializeGroundItem(Rs2TileItemModel item, WorldPoint me, Map<WorldPoint, Integer> reach) {
		WorldPoint loc = item.getWorldLocation();
		if (loc == null) {
			return null;
		}
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("id", item.getId());
		m.put("name", item.getName());
		m.put("quantity", item.getQuantity());
		m.put("position", point(loc));
		m.put("distance", loc.distanceTo(me));
		m.put("geValue", item.getTotalGeValue());
		m.put("lootable", item.isLootAble());
		putReach(m, reach, loc, 1, 1);
		return m;
	}

	/**
	 * An entity is reachable when the player can stand on its tile or on any tile bordering its
	 * footprint (you interact with rocks, booths and NPCs from beside them). pathDistance is the
	 * walking distance to the best such tile.
	 */
	private static void putReach(Map<String, Object> m, Map<WorldPoint, Integer> reach, WorldPoint loc, int sizeX, int sizeY) {
		int best = Integer.MAX_VALUE;
		int halfX = Math.max(1, sizeX) / 2;
		int halfY = Math.max(1, sizeY) / 2;
		for (int dx = -halfX - 1; dx <= halfX + 1; dx++) {
			for (int dy = -halfY - 1; dy <= halfY + 1; dy++) {
				Integer d = reach.get(new WorldPoint(loc.getX() + dx, loc.getY() + dy, loc.getPlane()));
				if (d != null && d < best) {
					best = d;
				}
			}
		}
		m.put("reachable", best != Integer.MAX_VALUE);
		m.put("pathDistance", best == Integer.MAX_VALUE ? -1 : best);
	}

	/**
	 * Like {@link #putReach}, but only counts the tiles straight beside the footprint (not its
	 * corners) whose edge toward the object has no wall: next to a spinning wheel on the far side of
	 * a room's wall is not "reachable", and clicking it there fails with "I can't reach that!".
	 */
	private void putReachThroughWalls(Map<String, Object> m, Map<WorldPoint, Integer> reach, WorldPoint loc, int sizeX, int sizeY) {
		int best = Integer.MAX_VALUE;
		int halfX = Math.max(1, sizeX) / 2;
		int halfY = Math.max(1, sizeY) / 2;
		int[][] flags = collisionFlags(loc.getPlane());
		for (int dx = -halfX - 1; dx <= halfX + 1; dx++) {
			for (int dy = -halfY - 1; dy <= halfY + 1; dy++) {
				boolean westOrEast = dx == -halfX - 1 || dx == halfX + 1;
				boolean southOrNorth = dy == -halfY - 1 || dy == halfY + 1;
				if (westOrEast && southOrNorth) continue;
				WorldPoint tile = new WorldPoint(loc.getX() + dx, loc.getY() + dy, loc.getPlane());
				Integer d = reach.get(tile);
				if (d == null || d >= best) continue;
				if (westOrEast || southOrNorth) {
					int toward = dx == -halfX - 1 ? CollisionDataFlag.BLOCK_MOVEMENT_EAST
						: dx == halfX + 1 ? CollisionDataFlag.BLOCK_MOVEMENT_WEST
						: dy == -halfY - 1 ? CollisionDataFlag.BLOCK_MOVEMENT_NORTH
						: CollisionDataFlag.BLOCK_MOVEMENT_SOUTH;
					if (wallFlag(flags, tile, toward)) continue;
				}
				best = d;
			}
		}
		m.put("reachable", best != Integer.MAX_VALUE);
		m.put("pathDistance", best == Integer.MAX_VALUE ? -1 : best);
	}

	private int[][] collisionFlags(int plane) {
		WorldView wv = client.getTopLevelWorldView();
		CollisionData[] maps = wv == null ? null : wv.getCollisionMaps();
		return maps == null || plane < 0 || plane >= maps.length ? null : maps[plane].getFlags();
	}

	private boolean wallFlag(int[][] flags, WorldPoint tile, int flag) {
		if (flags == null) return false;
		LocalPoint lp = LocalPoint.fromWorld(client.getTopLevelWorldView(), tile);
		if (lp == null) return false;
		int sx = lp.getSceneX();
		int sy = lp.getSceneY();
		if (sx < 0 || sy < 0 || sx >= flags.length || sy >= flags[sx].length) return false;
		return (flags[sx][sy] & flag) != 0;
	}

	private Map<String, Object> readInventory() {
		List<Map<String, Object>> items = Rs2Inventory.all().stream()
				.map(item -> {
					Map<String, Object> m = new LinkedHashMap<>();
					m.put("slot", item.getSlot());
					m.put("id", item.getId());
					m.put("name", item.getName());
					m.put("quantity", item.getQuantity());
					m.put("noted", item.isNoted());
					m.put("stackable", item.isStackable());
					m.put("actions", actions(item.getInventoryActions()));
					return m;
				})
				.collect(Collectors.toList());
		Map<String, Object> inv = new LinkedHashMap<>();
		inv.put("freeSlots", Rs2Inventory.emptySlotCount());
		inv.put("items", items);
		return inv;
	}

	private List<Map<String, Object>> readEquipment() {
		Map<Integer, String> slotNames = new HashMap<>();
		for (EquipmentInventorySlot slot : EquipmentInventorySlot.values()) {
			slotNames.put(slot.getSlotIdx(), slot.name());
		}
		List<Map<String, Object>> out = new ArrayList<>();
		for (Rs2ItemModel item : Rs2Equipment.items()) {
			if (item == null) continue;
			Map<String, Object> m = new LinkedHashMap<>();
			m.put("slot", slotNames.getOrDefault(item.getSlot(), String.valueOf(item.getSlot())));
			m.put("id", item.getId());
			m.put("name", item.getName());
			m.put("quantity", item.getQuantity());
			out.add(m);
		}
		return out;
	}

	private Map<String, Object> readDialogue() {
		Map<String, Object> d = new LinkedHashMap<>();
		boolean inDialogue = Rs2Dialogue.isInDialogue();
		d.put("inDialogue", inDialogue);
		d.put("hasContinue", inDialogue && Rs2Dialogue.hasContinue());
		boolean hasOptions = inDialogue && Rs2Dialogue.hasSelectAnOption();
		d.put("hasOptions", hasOptions);
		// Never Collections.emptyList(): Gson 2.8 reflects into it, which Java 17 blocks unless the
		// JVM runs with --add-opens java.base/java.util (the launcher adds it; :client:run does not).
		List<String> options = new ArrayList<>();
		if (inDialogue) {
			String text = Rs2Dialogue.getDialogueText();
			if (text != null && !text.isEmpty()) {
				d.put("text", Rs2UiHelper.stripColTags(text));
			}
			if (hasOptions) {
				String question = Rs2Dialogue.getQuestion();
				if (question != null && !question.isEmpty()) {
					d.put("question", Rs2UiHelper.stripColTags(question));
				}
				List<Widget> widgets = Rs2Dialogue.getDialogueOptions();
				if (widgets != null) {
					options = widgets.stream()
							.filter(w -> w != null && w.getText() != null && !w.getText().isEmpty())
							.map(w -> Rs2UiHelper.stripColTags(w.getText()))
							.collect(Collectors.toList());
				}
			}
		}
		d.put("options", options);
		return d;
	}

	/**
	 * The skilling "how many?" interface (cook/smelt/fletch...) or the anvil smithing grid, with
	 * the product names each offers.
	 */
	private Map<String, Object> readProduction() {
		Map<String, Object> p = new LinkedHashMap<>();
		if (AgentWidgets.isSmithingOpen()) {
			p.put("open", true);
			p.put("interface", "smithing");
			p.put("options", AgentWidgets.smithingOptions(client));
			return p;
		}
		boolean open = Rs2Widget.isProductionWidgetOpen();
		p.put("open", open);
		p.put("interface", open ? "make" : null);
		List<String> options = new ArrayList<>();
		if (open) {
			Microbot.getClientThread().runOnClientThreadOptional(() -> {
				for (int child = 0; child < 40; child++) {
					Widget w = client.getWidget(InterfaceID.SKILLMULTI, child);
					if (w == null || w.isHidden()) continue;
					String name = w.getName();
					if (name != null && !name.isEmpty() && w.getActions() != null) {
						String clean = Rs2UiHelper.stripColTags(name);
						if (!options.contains(clean)) options.add(clean);
					}
				}
				return true;
			});
		}
		p.put("options", options);
		return p;
	}

	private Map<String, Object> readShop() {
		Map<String, Object> s = new LinkedHashMap<>();
		boolean open = Rs2Shop.isOpen();
		s.put("open", open);
		List<Map<String, Object>> items = new ArrayList<>();
		if (open) {
			for (Rs2ItemModel item : new ArrayList<>(Rs2Shop.shopItems)) {
				if (item == null || item.getId() == -1) continue;
				Map<String, Object> m = new LinkedHashMap<>();
				m.put("id", item.getId());
				m.put("name", item.getName());
				m.put("quantity", item.getQuantity());
				items.add(m);
			}
		}
		s.put("items", items);
		return s;
	}

	private Map<String, Object> readBank(int maxItems) {
		Map<String, Object> b = new LinkedHashMap<>();
		boolean open = Rs2Bank.isOpen();
		b.put("open", open);
		List<Map<String, Object>> items = new ArrayList<>();
		if (open) {
			for (Rs2ItemModel item : Rs2Bank.bankItems()) {
				if (items.size() >= maxItems) break;
				if (item == null) continue;
				Map<String, Object> m = new LinkedHashMap<>();
				m.put("slot", item.getSlot());
				m.put("id", item.getId());
				m.put("name", item.getName());
				m.put("quantity", item.getQuantity());
				items.add(m);
			}
		}
		b.put("items", items);
		return b;
	}

	private static List<String> actions(String[] raw) {
		if (raw == null) return new ArrayList<>();
		return Arrays.stream(raw)
				.filter(a -> a != null && !a.isEmpty() && !"Hidden".equalsIgnoreCase(a))
				.map(Rs2UiHelper::stripColTags)
				.collect(Collectors.toList());
	}

	private static Map<String, Integer> point(WorldPoint p) {
		Map<String, Integer> m = new LinkedHashMap<>();
		m.put("x", p.getX());
		m.put("y", p.getY());
		m.put("plane", p.getPlane());
		return m;
	}

	private static Map<String, Integer> pair(int current, int max) {
		Map<String, Integer> m = new LinkedHashMap<>();
		m.put("current", current);
		m.put("max", max);
		return m;
	}

	private static int clamp(int v, int lo, int hi) {
		return Math.max(lo, Math.min(hi, v));
	}
}
