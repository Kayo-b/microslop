package net.runelite.client.plugins.microbot.agentserver;

import net.runelite.api.Client;
import net.runelite.api.MenuAction;
import net.runelite.api.gameval.InterfaceID;
import net.runelite.api.widgets.Widget;
import net.runelite.client.plugins.microbot.Microbot;
import net.runelite.client.plugins.microbot.util.menu.NewMenuEntry;
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

	public static boolean isTanningOpen()
	{
		return Rs2Widget.isWidgetVisible(InterfaceID.TANNER, 0);
	}

	/** Leathers the tanner offers, by the name on their button ("Leather", "Hard leather", ...). */
	public static List<String> tanningOptions(Client client)
	{
		List<String> names = new ArrayList<>();
		Microbot.getClientThread().runOnClientThreadOptional(() -> {
			for (Widget w : tanningButtons(client))
			{
				String clean = Rs2UiHelper.stripColTags(w.getName()).trim();
				if (!clean.isEmpty() && !names.contains(clean))
				{
					names.add(clean);
				}
			}
			return true;
		});
		return names;
	}

	/**
	 * Tans every carried hide of the leather named {@code option} (case-insensitive), through the
	 * button's "Tan All" menu option. Returns false when the tanner lists no such leather.
	 */
	public static boolean tanAll(Client client, String option)
	{
		String wanted = option.toLowerCase(Locale.ROOT);
		Object[] hit = Microbot.getClientThread().runOnClientThreadOptional(() -> {
			for (Widget w : tanningButtons(client))
			{
				if (!Rs2UiHelper.stripColTags(w.getName()).trim().toLowerCase(Locale.ROOT).equals(wanted))
				{
					continue;
				}
				String[] actions = w.getActions();
				for (int i = 0; i < actions.length; i++)
				{
					if (actions[i] != null && actions[i].equalsIgnoreCase("Tan All"))
					{
						return new Object[]{w.getId(), w.getIndex(), i + 1, w.getBounds(), w.getName()};
					}
				}
			}
			return null;
		}).orElse(null);
		if (hit == null)
		{
			return false;
		}
		NewMenuEntry entry = new NewMenuEntry()
			.option("Tan All")
			.target((String) hit[4])
			.identifier((Integer) hit[2])
			.type(MenuAction.CC_OP)
			.param0((Integer) hit[1])
			.param1((Integer) hit[0])
			.forceLeftClick(false);
		Microbot.doInvoke(entry, (java.awt.Rectangle) hit[3]);
		return true;
	}

	private static List<Widget> tanningButtons(Client client)
	{
		List<Widget> out = new ArrayList<>();
		List<Widget> all = new ArrayList<>();
		for (int child = 0; child < 128; child++)
		{
			Widget w = client.getWidget(InterfaceID.TANNER, child);
			if (w != null)
			{
				collect(w, all, 0);
			}
		}
		for (Widget w : all)
		{
			String[] actions = w.getActions();
			if (w.isHidden() || w.getName() == null || w.getName().isEmpty() || actions == null)
			{
				continue;
			}
			for (String a : actions)
			{
				if (a != null && a.equalsIgnoreCase("Tan All"))
				{
					out.add(w);
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
