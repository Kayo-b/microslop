package net.runelite.client.plugins.microbot.agentserver;

import java.awt.Rectangle;
import java.awt.Shape;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import net.runelite.api.Client;
import net.runelite.api.MenuAction;
import net.runelite.api.Player;
import net.runelite.api.gameval.InterfaceID;
import net.runelite.api.widgets.Widget;
import net.runelite.client.plugins.microbot.Microbot;
import net.runelite.client.plugins.microbot.util.menu.NewMenuEntry;
import net.runelite.client.plugins.microbot.util.misc.Rs2UiHelper;
import net.runelite.client.plugins.microbot.util.widget.Rs2Widget;

/**
 * Player-to-player trading for the agent endpoints, deliberately narrow: trade one player named by
 * the caller (moving coins between the account's own characters), offer an inventory item, accept
 * both trade screens, read what both sides offer. Nothing here targets players in general.
 */
public final class AgentTrade
{
	private AgentTrade()
	{
	}

	/** "offer" (first screen), "confirm" (second screen) or null. */
	public static String stage()
	{
		if (Rs2Widget.isWidgetVisible(InterfaceID.TRADEMAIN, 0))
		{
			return "offer";
		}
		if (Rs2Widget.isWidgetVisible(InterfaceID.TRADECONFIRM, 0))
		{
			return "confirm";
		}
		return null;
	}

	/** Sends "Trade with" to the player with this exact name (case-insensitive); false when not in view. */
	public static boolean tradePlayer(Client client, String name)
	{
		String wanted = name.toLowerCase(Locale.ROOT).replace(' ', ' ');
		Object[] hit = Microbot.getClientThread().runOnClientThreadOptional(() -> {
			String[] options = client.getPlayerOptions();
			int idx = -1;
			for (int i = 0; options != null && i < options.length; i++)
			{
				if (options[i] != null && Rs2UiHelper.stripColTags(options[i]).equalsIgnoreCase("Trade with"))
				{
					idx = i;
					break;
				}
			}
			if (idx < 0)
			{
				return null;
			}
			for (Player p : client.getTopLevelWorldView().players())
			{
				if (p == null || p == client.getLocalPlayer() || p.getName() == null)
				{
					continue;
				}
				if (p.getName().toLowerCase(Locale.ROOT).replace(' ', ' ').equals(wanted))
				{
					Shape hull = p.getConvexHull();
					Rectangle bounds = hull != null ? hull.getBounds() : new Rectangle(1, 1);
					return new Object[]{p.getId(), idx, bounds, p.getName()};
				}
			}
			return null;
		}).orElse(null);
		if (hit == null)
		{
			return false;
		}
		MenuAction action = MenuAction.of(MenuAction.PLAYER_FIRST_OPTION.getId() + (Integer) hit[1]);
		Microbot.doInvoke(new NewMenuEntry()
			.option("Trade with")
			.target((String) hit[3])
			.identifier((Integer) hit[0])
			.type(action)
			.param0(0)
			.param1(0)
			.forceLeftClick(false), (Rectangle) hit[2]);
		return true;
	}

	/**
	 * Offers an inventory item through the trade side panel's menu option (e.g. "Offer-All");
	 * false when the trade screen is not open or the item/option is missing.
	 */
	public static boolean offer(Client client, String itemName, String option)
	{
		String wantedItem = itemName.trim().toLowerCase(Locale.ROOT);
		Object[] hit = Microbot.getClientThread().runOnClientThreadOptional(() -> {
			Widget side = client.getWidget(InterfaceID.Tradeside.SIDE_LAYER);
			Widget[] kids = side == null ? null : side.getDynamicChildren();
			if (kids == null)
			{
				return null;
			}
			for (Widget w : kids)
			{
				if (w == null || w.getItemId() <= 0 || w.getName() == null)
				{
					continue;
				}
				if (!Rs2UiHelper.stripColTags(w.getName()).trim().toLowerCase(Locale.ROOT).equals(wantedItem))
				{
					continue;
				}
				String[] actions = w.getActions();
				for (int i = 0; actions != null && i < actions.length; i++)
				{
					if (actions[i] != null && Rs2UiHelper.stripColTags(actions[i]).trim().equalsIgnoreCase(option))
					{
						return new Object[]{w.getId(), w.getIndex(), i + 1, w.getBounds(), w.getItemId(), w.getName()};
					}
				}
			}
			return null;
		}).orElse(null);
		if (hit == null)
		{
			return false;
		}
		Microbot.doInvoke(new NewMenuEntry()
			.option(option)
			.target((String) hit[5])
			.identifier((Integer) hit[2])
			.type(MenuAction.CC_OP)
			.param0((Integer) hit[1])
			.param1((Integer) hit[0])
			.itemId((Integer) hit[4])
			.forceLeftClick(false), (Rectangle) hit[3]);
		return true;
	}

	/** Clicks Accept on whichever trade screen is open; false when none is. */
	public static boolean accept()
	{
		String stage = stage();
		if ("offer".equals(stage))
		{
			return Rs2Widget.clickWidget(InterfaceID.Trademain.ACCEPT);
		}
		if ("confirm".equals(stage))
		{
			return Rs2Widget.clickWidget(InterfaceID.Tradeconfirm.TRADE2ACCEPT);
		}
		return false;
	}

	public static boolean decline()
	{
		String stage = stage();
		if ("offer".equals(stage))
		{
			return Rs2Widget.clickWidget(InterfaceID.Trademain.DECLINE);
		}
		if ("confirm".equals(stage))
		{
			return Rs2Widget.clickWidget(InterfaceID.Tradeconfirm.TRADE2DECLINE);
		}
		return false;
	}

	/** Trade state for the snapshot: stage, status line, and both offers (item names and amounts). */
	public static Map<String, Object> read(Client client)
	{
		Map<String, Object> t = new LinkedHashMap<>();
		String stage = stage();
		t.put("open", stage != null);
		t.put("stage", stage);
		if (stage == null)
		{
			return t;
		}
		Microbot.getClientThread().runOnClientThreadOptional(() -> {
			if ("offer".equals(stage))
			{
				Widget status = client.getWidget(InterfaceID.Trademain.STATUS);
				t.put("status", status == null || status.getText() == null ? "" : Rs2UiHelper.stripColTags(status.getText()));
				t.put("mine", items(client.getWidget(InterfaceID.Trademain.YOUR_OFFER)));
				t.put("theirs", items(client.getWidget(InterfaceID.Trademain.OTHER_OFFER)));
			}
			else
			{
				Widget mine = client.getWidget(InterfaceID.Tradeconfirm.YOUR_OFFER);
				Widget theirs = client.getWidget(InterfaceID.Tradeconfirm.OTHER_OFFER);
				t.put("mine", texts(mine));
				t.put("theirs", texts(theirs));
			}
			return true;
		});
		return t;
	}

	private static List<Map<String, Object>> items(Widget container)
	{
		List<Map<String, Object>> out = new ArrayList<>();
		Widget[] kids = container == null ? null : container.getDynamicChildren();
		for (int i = 0; kids != null && i < kids.length; i++)
		{
			Widget w = kids[i];
			if (w == null || w.getItemId() <= 0)
			{
				continue;
			}
			Map<String, Object> m = new LinkedHashMap<>();
			m.put("itemId", w.getItemId());
			m.put("quantity", w.getItemQuantity());
			out.add(m);
		}
		return out;
	}

	private static List<String> texts(Widget container)
	{
		List<String> out = new ArrayList<>();
		Widget[] kids = container == null ? null : container.getDynamicChildren();
		for (int i = 0; kids != null && i < kids.length; i++)
		{
			Widget w = kids[i];
			if (w != null && w.getText() != null && !w.getText().isEmpty())
			{
				out.add(Rs2UiHelper.stripColTags(w.getText()));
			}
		}
		return out;
	}
}
