package net.runelite.agentengine.kb;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.io.BufferedWriter;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.runelite.cache.AreaManager;
import net.runelite.cache.EntityOpsDefinition;
import net.runelite.cache.IndexType;
import net.runelite.cache.ItemManager;
import net.runelite.cache.NpcManager;
import net.runelite.cache.ObjectManager;
import net.runelite.cache.WorldMapManager;
import net.runelite.cache.definitions.AreaDefinition;
import net.runelite.cache.definitions.WorldMapElementDefinition;
import net.runelite.cache.region.Position;
import net.runelite.cache.definitions.ItemDefinition;
import net.runelite.cache.definitions.LocationsDefinition;
import net.runelite.cache.definitions.MapDefinition;
import net.runelite.cache.definitions.NpcDefinition;
import net.runelite.cache.definitions.ObjectDefinition;
import net.runelite.cache.definitions.loaders.LocationsLoader;
import net.runelite.cache.definitions.loaders.MapLoader;
import net.runelite.cache.fs.Archive;
import net.runelite.cache.fs.Index;
import net.runelite.cache.fs.Storage;
import net.runelite.cache.fs.Store;
import net.runelite.cache.region.Location;

/**
 * Dumps the parts of an OSRS disk cache the agent engine needs into JSONL files:
 *
 * <ul>
 *   <li>{@code items.jsonl}: item definitions (name, inventory/ground actions, noted, stackable, members)</li>
 *   <li>{@code npcs.jsonl}: NPC definitions (name, actions, combat level, size, multi-npc transforms)</li>
 *   <li>{@code objects.jsonl}: object (loc) definitions (name, actions, size, multi-loc transforms)</li>
 *   <li>{@code locations.jsonl}: world placements of interactable objects as {@code [id,x,y,plane,type,orientation]}</li>
 *   <li>{@code map_elements.jsonl}: world map icons and labels (banks, furnaces, mining sites, town names) with positions</li>
 * </ul>
 *
 * Usage: {@code KbDumper <cacheDir> <outDir>}
 *
 * Map location archives were XTEA-encrypted up to revision 236; from 237 onwards OpenRS2 publishes no keys and
 * the archives decode unencrypted. Encrypted regions are skipped and counted, never fatal.
 */
public final class KbDumper
{
	private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

	private KbDumper()
	{
	}

	public static void main(String[] args) throws IOException
	{
		if (args.length != 2)
		{
			System.err.println("usage: KbDumper <cacheDir> <outDir>");
			System.exit(2);
		}
		File cacheDir = new File(args[0]);
		Path outDir = Path.of(args[1]);
		Files.createDirectories(outDir);

		try (Store store = new Store(cacheDir))
		{
			store.load();

			ItemManager items = new ItemManager(store);
			items.load();
			int itemCount = dumpItems(items.getItems(), outDir.resolve("items.jsonl"));

			NpcManager npcs = new NpcManager(store);
			npcs.load();
			int npcCount = dumpNpcs(npcs.getNpcs(), outDir.resolve("npcs.jsonl"));

			ObjectManager objects = new ObjectManager(store);
			objects.load();
			int objectCount = dumpObjects(objects.getObjects(), outDir.resolve("objects.jsonl"));

			Map<Integer, ObjectDefinition> objectById = new HashMap<>();
			for (ObjectDefinition def : objects.getObjects())
			{
				objectById.put(def.getId(), def);
			}
			int[] locStats = dumpLocations(store, objectById, outDir.resolve("locations.jsonl"));
			int mapElementCount = dumpMapElements(store, outDir.resolve("map_elements.jsonl"));

			Map<String, Object> manifest = new LinkedHashMap<>();
			manifest.put("cacheDir", cacheDir.getAbsolutePath());
			manifest.put("items", itemCount);
			manifest.put("npcs", npcCount);
			manifest.put("objects", objectCount);
			manifest.put("locations", locStats[0]);
			manifest.put("regionsDecoded", locStats[1]);
			manifest.put("regionsSkippedEncrypted", locStats[2]);
			manifest.put("mapElements", mapElementCount);
			Files.writeString(outDir.resolve("manifest.json"), GSON.toJson(manifest), StandardCharsets.UTF_8);
			System.out.println(GSON.toJson(manifest));
		}
	}

	private static int dumpItems(Collection<ItemDefinition> defs, Path out) throws IOException
	{
		int n = 0;
		try (BufferedWriter w = Files.newBufferedWriter(out, StandardCharsets.UTF_8))
		{
			for (ItemDefinition d : defs)
			{
				if (isNull(d.name))
				{
					continue;
				}
				Map<String, Object> m = new LinkedHashMap<>();
				m.put("id", d.id);
				m.put("name", d.name);
				m.put("members", d.members);
				m.put("stackable", d.stackable == 1);
				m.put("noted", d.notedTemplate != -1);
				m.put("notedId", d.notedID);
				m.put("placeholder", d.placeholderTemplateId != -1);
				m.put("tradeable", d.tradeable);
				m.put("cost", d.cost);
				m.put("weight", d.weight);
				m.put("wearPos", d.wearPos1);
				m.put("category", d.category);
				m.put("inventoryActions", compact(d.interfaceOptions));
				m.put("groundActions", opTexts(d.groundOps));
				writeLine(w, m);
				n++;
			}
		}
		return n;
	}

	private static int dumpNpcs(Collection<NpcDefinition> defs, Path out) throws IOException
	{
		int n = 0;
		try (BufferedWriter w = Files.newBufferedWriter(out, StandardCharsets.UTF_8))
		{
			for (NpcDefinition d : defs)
			{
				boolean hasTransforms = d.configs != null && d.configs.length > 0;
				if (isNull(d.name) && !hasTransforms)
				{
					continue;
				}
				Map<String, Object> m = new LinkedHashMap<>();
				m.put("id", d.id);
				m.put("name", isNull(d.name) ? null : d.name);
				m.put("combatLevel", d.combatLevel);
				m.put("size", d.size);
				m.put("category", d.category);
				m.put("interactable", d.isInteractable);
				m.put("follower", d.isFollower);
				m.put("actions", opTexts(d.ops));
				m.put("conditionalActions", conditionalOpTexts(d.ops));
				m.put("stats", d.stats);
				if (hasTransforms)
				{
					m.put("transforms", d.configs);
					m.put("varbit", d.varbitId);
					m.put("varp", d.varpIndex);
				}
				writeLine(w, m);
				n++;
			}
		}
		return n;
	}

	private static int dumpObjects(Collection<ObjectDefinition> defs, Path out) throws IOException
	{
		int n = 0;
		try (BufferedWriter w = Files.newBufferedWriter(out, StandardCharsets.UTF_8))
		{
			for (ObjectDefinition d : defs)
			{
				boolean hasTransforms = d.getConfigChangeDest() != null && d.getConfigChangeDest().length > 0;
				if (isNull(d.getName()) && !hasTransforms)
				{
					continue;
				}
				Map<String, Object> m = new LinkedHashMap<>();
				m.put("id", d.getId());
				m.put("name", isNull(d.getName()) ? null : d.getName());
				m.put("sizeX", d.getSizeX());
				m.put("sizeY", d.getSizeY());
				m.put("category", d.getCategory());
				m.put("mapAreaId", d.getMapAreaId());
				m.put("interactType", d.getInteractType());
				m.put("wallOrDoor", d.getWallOrDoor());
				m.put("actions", opTexts(d.getOps()));
				m.put("conditionalActions", conditionalOpTexts(d.getOps()));
				if (hasTransforms)
				{
					m.put("transforms", d.getConfigChangeDest());
					m.put("varbit", d.getVarbitID());
					m.put("varp", d.getVarpID());
				}
				writeLine(w, m);
				n++;
			}
		}
		return n;
	}

	/**
	 * Writes every placement whose object (or one of its multi-loc transforms) has a name and at least one action.
	 * Scenery with no actions is dropped: the agent can never interact with it, and it is most of the map.
	 *
	 * @return {placements written, regions decoded, regions skipped because they are still encrypted}
	 */
	private static int[] dumpLocations(Store store, Map<Integer, ObjectDefinition> objects, Path out) throws IOException
	{
		Index maps = store.getIndex(IndexType.MAPS);
		Storage storage = store.getStorage();
		Map<Integer, Boolean> interactable = new HashMap<>();
		int written = 0;
		int decoded = 0;
		int skipped = 0;

		try (BufferedWriter w = Files.newBufferedWriter(out, StandardCharsets.UTF_8))
		{
			for (int rx = 0; rx < 256; rx++)
			{
				for (int ry = 0; ry < 256; ry++)
				{
					byte[] locData;
					byte[] mapData = null;
					try
					{
						if (maps.isNamed())
						{
							// Revision <= 236: separate "m{x}_{y}" / "l{x}_{y}" archives, locs XTEA-encrypted.
							Archive locArchive = maps.findArchiveByName("l" + rx + "_" + ry);
							if (locArchive == null)
							{
								continue;
							}
							locData = locArchive.decompress(storage.loadArchive(locArchive), null);
							Archive mapArchive = maps.findArchiveByName("m" + rx + "_" + ry);
							if (mapArchive != null)
							{
								mapData = mapArchive.decompress(storage.loadArchive(mapArchive));
							}
						}
						else
						{
							// Revision >= 237: one archive per region id, file 0 = terrain, file 1 = locs.
							Archive archive = maps.getArchive((rx << 8) | ry);
							if (archive == null)
							{
								continue;
							}
							var files = archive.getFiles(storage.loadArchive(archive));
							if (files.findFile(1) == null)
							{
								continue;
							}
							locData = files.findFile(1).getContents();
							if (files.findFile(0) != null)
							{
								mapData = files.findFile(0).getContents();
							}
						}
					}
					catch (Exception e)
					{
						skipped++;
						continue;
					}

					LocationsDefinition locs;
					try
					{
						locs = new LocationsLoader().load(rx, ry, locData);
					}
					catch (Exception e)
					{
						skipped++;
						continue;
					}

					MapDefinition map = null;
					if (mapData != null)
					{
						try
						{
							map = new MapLoader().load(rx, ry, mapData);
						}
						catch (Exception ignored)
						{
							// Without terrain we cannot apply the bridge plane shift; placements stay usable.
						}
					}

					decoded++;
					int baseX = rx << 6;
					int baseY = ry << 6;
					for (Location loc : locs.getLocations())
					{
						if (!interactable.computeIfAbsent(loc.getId(), id -> isInteractable(id, objects)))
						{
							continue;
						}
						int lx = loc.getPosition().getX();
						int ly = loc.getPosition().getY();
						int plane = loc.getPosition().getZ();
						// Tiles flagged as bridges (setting bit 2 on plane 1) render everything one plane lower.
						if (map != null && plane > 0)
						{
							MapDefinition.Tile bridge = map.getTiles()[1][lx][ly];
							if (bridge != null && (bridge.settings & 2) != 0)
							{
								plane--;
							}
						}
						w.write(GSON.toJson(new int[]{
							loc.getId(), baseX + lx, baseY + ly, plane, loc.getType(), loc.getOrientation()}));
						w.write('\n');
						written++;
					}
				}
			}
		}
		return new int[]{written, decoded, skipped};
	}

	private static int dumpMapElements(Store store, Path out) throws IOException
	{
		AreaManager areas = new AreaManager(store);
		areas.load();
		WorldMapManager worldMap = new WorldMapManager(store);
		worldMap.load();

		int n = 0;
		try (BufferedWriter w = Files.newBufferedWriter(out, StandardCharsets.UTF_8))
		{
			for (WorldMapElementDefinition element : worldMap.getElements())
			{
				AreaDefinition area = areas.getArea(element.areaDefinitionId);
				if (area == null || isNull(area.name))
				{
					continue;
				}
				Position pos = element.getWorldPosition();
				Map<String, Object> m = new LinkedHashMap<>();
				m.put("areaId", area.id);
				// Labels carry <br> line breaks for rendering; the agent wants one line.
				m.put("name", area.name.replace("<br>", " "));
				m.put("category", area.category);
				m.put("isLabel", area.textScale > 0 || area.spriteId == -1);
				m.put("x", pos.getX());
				m.put("y", pos.getY());
				m.put("plane", pos.getZ());
				m.put("members", element.membersOnly);
				writeLine(w, m);
				n++;
			}
		}

		// Icon/label names by area id, so objects.jsonl mapAreaId (bank booths, furnaces, anvils...) resolves.
		try (BufferedWriter w = Files.newBufferedWriter(out.resolveSibling("areas.jsonl"), StandardCharsets.UTF_8))
		{
			for (AreaDefinition area : areas.getAreas())
			{
				if (isNull(area.name))
				{
					continue;
				}
				Map<String, Object> m = new LinkedHashMap<>();
				m.put("id", area.id);
				m.put("name", area.name.replace("<br>", " "));
				m.put("category", area.category);
				m.put("spriteId", area.spriteId);
				writeLine(w, m);
			}
		}
		return n;
	}

	private static boolean isInteractable(int id, Map<Integer, ObjectDefinition> objects)
	{
		ObjectDefinition def = objects.get(id);
		if (def == null)
		{
			return false;
		}
		if (!isNull(def.getName()) && !opTexts(def.getOps()).isEmpty())
		{
			return true;
		}
		int[] transforms = def.getConfigChangeDest();
		if (transforms == null)
		{
			return false;
		}
		for (int t : transforms)
		{
			ObjectDefinition td = objects.get(t);
			if (td != null && !isNull(td.getName()) && !opTexts(td.getOps()).isEmpty())
			{
				return true;
			}
		}
		return false;
	}

	private static List<String> opTexts(EntityOpsDefinition ops)
	{
		List<String> out = new ArrayList<>();
		if (ops == null || ops.getOps() == null)
		{
			return out;
		}
		for (EntityOpsDefinition.Op op : ops.getOps())
		{
			if (op != null && op.text != null && !op.text.isEmpty() && !"Hidden".equalsIgnoreCase(op.text))
			{
				out.add(op.text);
			}
		}
		return out;
	}

	private static List<String> conditionalOpTexts(EntityOpsDefinition ops)
	{
		List<String> out = new ArrayList<>();
		if (ops == null || ops.getConditionalOps() == null)
		{
			return out;
		}
		for (List<EntityOpsDefinition.ConditionalOp> slot : ops.getConditionalOps())
		{
			if (slot == null)
			{
				continue;
			}
			for (EntityOpsDefinition.ConditionalOp op : slot)
			{
				if (op != null && op.text != null && !op.text.isEmpty() && !out.contains(op.text))
				{
					out.add(op.text);
				}
			}
		}
		return out;
	}

	private static List<String> compact(String[] values)
	{
		List<String> out = new ArrayList<>();
		if (values == null)
		{
			return out;
		}
		for (String v : values)
		{
			if (v != null && !v.isEmpty())
			{
				out.add(v);
			}
		}
		return out;
	}

	private static boolean isNull(String name)
	{
		return name == null || name.isEmpty() || "null".equalsIgnoreCase(name);
	}

	private static void writeLine(BufferedWriter w, Map<String, Object> m) throws IOException
	{
		w.write(GSON.toJson(m));
		w.write('\n');
	}
}
