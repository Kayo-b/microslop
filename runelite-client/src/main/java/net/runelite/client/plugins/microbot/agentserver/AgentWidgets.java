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
 * Anvil smithing interface (group 312) support for the agent endpoints. The skill-multi "make X"
 * chatbox (group 270) is already handled by {@link Rs2Widget#handleProcessingInterface}; smithing
 * uses its own grid of item buttons plus quantity toggles.
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
