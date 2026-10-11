package net.runelite.client.plugins.microbot.agentserver;

import net.runelite.api.Client;
import net.runelite.api.gameval.InterfaceID;
import net.runelite.api.widgets.Widget;
import net.runelite.client.plugins.microbot.Microbot;
import net.runelite.client.plugins.microbot.util.misc.Rs2UiHelper;
import net.runelite.client.plugins.microbot.util.widget.Rs2Widget;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import static net.runelite.client.plugins.microbot.util.Global.sleep;

/**
 * Anvil smithing interface (group 312) and tanner interface (group 324) support for the agent
 * endpoints. The skill-multi "make X" chatbox (group 270) is already handled by
 * {@link Rs2Widget#handleProcessingInterface}; smithing uses its own grid of item buttons plus
 * quantity toggles, and the tanner lists one button per leather with "Tan 1/5/10/X/All" options.
 */
public final class AgentWidgets
{
	private AgentWidgets()
	{
	}

	public static boolean isSmithingOpen()
	{
		return Rs2Widget.isSmithingWidgetOpen();
	}

	/** Names of the items the smithing interface offers (greyed-out ones included). */
	public static List<String> smithingOptions(Client client)
	{
		List<String> names = new ArrayList<>();
		Microbot.getClientThread().runOnClientThreadOptional(() -> {
			for (Widget w : smithingItemWidgets(client))
			{
				String clean = Rs2UiHelper.stripColTags(w.getName());
				if (!names.contains(clean))
				{
					names.add(clean);
				}
			}
			return true;
		});
		return names;
	}

	/**
	 * Selects the quantity toggle ({@code "1"}, {@code "5"}, {@code "10"} or {@code "All"}) when present,
	 * then clicks the item button whose name matches {@code option} (case-insensitive). Returns false
	 * when no such item is listed.
	 */
	public static boolean smith(Client client, String option, String quantity)
	{
		String wanted = option.toLowerCase(Locale.ROOT);
		String qty = quantity == null || quantity.isEmpty() ? "All" : quantity;
		Widget[] found = new Widget[2];
		Microbot.getClientThread().runOnClientThreadOptional(() -> {
			for (Widget w : allWidgets(client))
			{
				String text = w.getText() == null ? "" : Rs2UiHelper.stripColTags(w.getText()).trim();
				if (found[0] == null && qty.equalsIgnoreCase(text) && !w.isHidden())
				{
					found[0] = w;
				}
			}
			for (Widget w : smithingItemWidgets(client))
			{
				if (Rs2UiHelper.stripColTags(w.getName()).toLowerCase(Locale.ROOT).equals(wanted))
				{
					found[1] = w;
					break;
				}
			}
			return true;
		});
		if (found[1] == null)
		{
			return false;
		}
		if (found[0] != null)
		{
			Rs2Widget.clickWidget(found[0]);
			sleep(300, 600);
		}
		return Rs2Widget.clickWidget(found[1]);
	}


	/** The gold jewellery interface opened by using a bar on a furnace with a mould (group 446). */
	private static final int JEWELLERY_GROUP = 446;

	public static boolean isJewelleryOpen()
	{
		return Microbot.getClientThread().runOnClientThreadOptional(() -> {
			Widget close = client().getWidget(JEWELLERY_GROUP, 1);
			return close != null && !close.isHidden();
		}).orElse(false);
	}

	private static Client client()
	{
		return Microbot.getClient();
	}

	/** Products the jewellery interface offers: the widgets whose action reads "Make <product>". */
	public static List<String> jewelleryOptions(Client client)
	{
		List<String> names = new ArrayList<>();
		Microbot.getClientThread().runOnClientThreadOptional(() -> {
			for (Widget w : jewelleryWidgets(client))
			{
				String product = jewelleryProduct(w);
				if (product != null && !names.contains(product))
				{
					names.add(product);
				}
			}
			return true;
		});
		return names;
	}

	/** Clicks the product named {@code option} (case-insensitive, e.g. "Gold ring"); false when not offered. */
	public static boolean jewellery(Client client, String option)
	{
		String wanted = option.toLowerCase(Locale.ROOT);
		Widget found = Microbot.getClientThread().runOnClientThreadOptional(() -> {
			for (Widget w : jewelleryWidgets(client))
			{
				String product = jewelleryProduct(w);
				if (product != null && product.toLowerCase(Locale.ROOT).equals(wanted))
				{
					return w;
				}
			}
			return null;
		}).orElse(null);
		return found != null && Rs2Widget.clickWidget(found);
	}

	private static String jewelleryProduct(Widget w)
	{
		String[] actions = w.getActions();
		if (w.isHidden() || actions == null)
		{
			return null;
		}
		for (String a : actions)
		{
			if (a != null && a.startsWith("Make ") && a.length() > 5)
			{
				return Rs2UiHelper.stripColTags(a.substring(5)).trim();
			}
		}
		return null;
	}

	private static List<Widget> jewelleryWidgets(Client client)
	{
		List<Widget> out = new ArrayList<>();
		for (int child = 0; child < 128; child++)
		{
			Widget w = client.getWidget(JEWELLERY_GROUP, child);
			if (w != null)
			{
				collect(w, out, 0);
			}
		}
		return out;
	}

	public static boolean isTanningOpen()
	{
		return Rs2Widget.isWidgetVisible(InterfaceID.TANNER, 0);
	}

	/** Leathers the tanner offers, by the name under their picture ("Soft leather", "Hard leather", ...). */
	public static List<String> tanningOptions(Client client)
	{
		List<String> names = new ArrayList<>();
		Microbot.getClientThread().runOnClientThreadOptional(() -> {
			for (Object[] entry : tanningEntries(client))
			{
				names.add((String) entry[0]);
			}
			return true;
		});
		return names;
	}

	/**
	 * Tans the hides of the leather named {@code option} (case-insensitive) by left-clicking its
	 * picture, whose left-click option is "Tan All" (the menu ops are not exposed as widget actions,
	 * so a menu invoke does nothing). Returns false when the tanner lists no such leather.
	 */
	public static boolean tanAll(Client client, String option)
	{
		String wanted = option.toLowerCase(Locale.ROOT);
		Widget model = Microbot.getClientThread().runOnClientThreadOptional(() -> {
			for (Object[] entry : tanningEntries(client))
			{
				if (((String) entry[0]).toLowerCase(Locale.ROOT).equals(wanted))
				{
					return (Widget) entry[1];
				}
			}
			return null;
		}).orElse(null);
		return model != null && Rs2Widget.clickWidget(model);
	}

	/**
	 * The tanner's entries as [name, picture widget]: each sits in its own layer with a MODEL (the
	 * picture, clickable), a TEXT with the leather's name and a TEXT with the price in coins.
	 */
	private static List<Object[]> tanningEntries(Client client)
	{
		List<Widget> all = new ArrayList<>();
		for (int child = 0; child < 200; child++)
		{
			Widget w = client.getWidget(InterfaceID.TANNER, child);
			if (w != null && !w.isHidden())
			{
				all.add(w);
			}
		}
		List<Object[]> out = new ArrayList<>();
		for (Widget model : all)
		{
			if (model.getType() != net.runelite.api.widgets.WidgetType.MODEL)
			{
				continue;
			}
			for (Widget text : all)
			{
				String t = text.getText() == null ? "" : Rs2UiHelper.stripColTags(text.getText()).trim();
				if (text.getParentId() == model.getParentId() && text.getType() == net.runelite.api.widgets.WidgetType.TEXT
					&& !t.isEmpty() && !t.toLowerCase(Locale.ROOT).endsWith("coins"))
				{
					out.add(new Object[]{t, model});
					break;
				}
			}
		}
		return out;
	}

	private static List<Widget> smithingItemWidgets(Client client)
	{
		List<Widget> items = new ArrayList<>();
		for (Widget w : allWidgets(client))
		{
			String name = w.getName();
			String[] actions = w.getActions();
			if (w.isHidden() || name == null || name.isEmpty() || actions == null)
			{
				continue;
			}
			for (String a : actions)
			{
				if (a != null && a.toLowerCase(Locale.ROOT).startsWith("smith"))
				{
					items.add(w);
					break;
				}
			}
		}
		return items;
	}

	private static List<Widget> allWidgets(Client client)
	{
		List<Widget> out = new ArrayList<>();
		for (int child = 0; child < 128; child++)
		{
			Widget w = client.getWidget(InterfaceID.SMITHING, child);
			if (w != null)
			{
				collect(w, out, 0);
			}
		}
		return out;
	}

	private static void collect(Widget w, List<Widget> out, int depth)
	{
		if (w == null || depth > 4 || out.contains(w))
		{
			return;
		}
		out.add(w);
		for (Widget[] kids : new Widget[][]{w.getStaticChildren(), w.getDynamicChildren(), w.getNestedChildren()})
		{
			if (kids == null)
			{
				continue;
			}
			for (Widget k : kids)
			{
				collect(k, out, depth + 1);
			}
		}
	}
}
