package net.runelite.client.plugins.microbot.agentserver.handler;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import lombok.extern.slf4j.Slf4j;
import net.runelite.api.coords.WorldPoint;
import net.runelite.client.plugins.microbot.util.walker.Rs2PathApi;
import net.runelite.client.plugins.microbot.util.walker.Rs2RouteRequest;
import net.runelite.client.plugins.microbot.util.walker.Rs2RouteResult;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * {@code GET /path?from=x,y,plane&to=x,y,plane}: the web walker's route length between two points,
 * without starting a walk. Agents use it to compare candidate sites (mine, furnace, anvil, bank) by
 * real walking cost, since straight-line distance ignores walls, rivers and the Al Kharid toll gate.
 * <p>
 * Response: {@code {reachable, length, transports, searchMs}}. {@code length} counts path tiles,
 * with each transport (door, stairs, gate) as one step; {@code reachable} is false when the search
 * could not get within 3 tiles of the target (targets are usually solid objects, so the path ends
 * beside them).
 */
@Slf4j
public class PathHandler extends AgentHandler {

	private static final int REACH_TOLERANCE = 3;

	public PathHandler(Gson gson) {
		super(gson);
	}

	@Override
	public String getPath() {
		return "/path";
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
		WorldPoint from;
		WorldPoint to;
		try {
			from = point(params.get("from"));
			to = point(params.get("to"));
		} catch (IllegalArgumentException e) {
			sendJson(exchange, 400, errorResponse(e.getMessage()));
			return;
		}

		// Sites are usually solid objects (furnace, anvil, rocks); route between walkable tiles
		// beside them, or the search starts inside the object and ends immediately.
		from = walkable(from);
		to = walkable(to);

		Rs2RouteResult result;
		try {
			result = Rs2PathApi.plan(Rs2RouteRequest.to(from, to));
		} catch (IllegalStateException e) {
			sendJson(exchange, 503, errorResponse("Pathfinder unavailable: " + e.getMessage()));
			return;
		}

		Map<String, Object> response = new LinkedHashMap<>();
		response.put("reachable", result.isTargetReached(REACH_TOLERANCE));
		response.put("length", result.getPath().size());
		response.put("transports", result.getTransportSteps().size());
		response.put("searchMs", result.hasSearchNanos() ? result.getSearchNanos() / 1_000_000 : -1);
		sendJson(exchange, 200, response);
	}

	private static WorldPoint walkable(WorldPoint p) {
		WorldPoint w = Rs2PathApi.nearestWalkableTile(p, 3);
		return w != null ? w : p;
	}

	private static WorldPoint point(String raw) {
		if (raw == null) throw new IllegalArgumentException("from and to are required as x,y,plane");
		String[] parts = raw.split(",");
		if (parts.length < 2 || parts.length > 3) throw new IllegalArgumentException("Bad point: " + raw);
		try {
			return new WorldPoint(Integer.parseInt(parts[0].trim()), Integer.parseInt(parts[1].trim()),
				parts.length == 3 ? Integer.parseInt(parts[2].trim()) : 0);
		} catch (NumberFormatException e) {
			throw new IllegalArgumentException("Bad point: " + raw);
		}
	}
}
