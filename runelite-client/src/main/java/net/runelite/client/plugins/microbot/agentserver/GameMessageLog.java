package net.runelite.client.plugins.microbot.agentserver;

import net.runelite.api.ChatMessageType;
import net.runelite.client.plugins.microbot.util.misc.Rs2UiHelper;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Bounded log of recent game/system messages ("You catch some shrimps.", "I can't reach that!")
 * for the agent snapshot. These are the server's only feedback for many actions, so the agent
 * engine uses them to verify effects.
 * <p>
 * Player chat (public, private, clan, trade) is never recorded: it is other people's data and a
 * prompt-injection vector for anything that feeds messages to a model.
 */
public final class GameMessageLog
{
	private static final int CAPACITY = 50;
	private static final Set<ChatMessageType> RECORDED = EnumSet.of(
		ChatMessageType.GAMEMESSAGE,
		ChatMessageType.SPAM,
		ChatMessageType.ENGINE,
		ChatMessageType.MESBOX,
		ChatMessageType.LEVELUPMESSAGE
	);

	private static final ArrayDeque<Map<String, Object>> MESSAGES = new ArrayDeque<>(CAPACITY);

	private GameMessageLog()
	{
	}

	public static void record(int tick, ChatMessageType type, String message)
	{
		if (type == null || message == null || !RECORDED.contains(type))
		{
			return;
		}
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put("tick", tick);
		entry.put("type", type.name());
		entry.put("text", Rs2UiHelper.stripColTags(message));
		synchronized (MESSAGES)
		{
			if (MESSAGES.size() >= CAPACITY)
			{
				MESSAGES.pollFirst();
			}
			MESSAGES.addLast(entry);
		}
	}

	/** The most recent {@code limit} messages, oldest first. */
	public static List<Map<String, Object>> recent(int limit)
	{
		synchronized (MESSAGES)
		{
			List<Map<String, Object>> all = new ArrayList<>(MESSAGES);
			int from = Math.max(0, all.size() - Math.max(0, limit));
			return new ArrayList<>(all.subList(from, all.size()));
		}
	}

	public static void clear()
	{
		synchronized (MESSAGES)
		{
			MESSAGES.clear();
		}
	}
}
