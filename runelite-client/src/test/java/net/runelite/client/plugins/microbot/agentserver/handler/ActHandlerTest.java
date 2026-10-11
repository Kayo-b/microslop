package net.runelite.client.plugins.microbot.agentserver.handler;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpServer;
import net.runelite.api.Client;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Request validation for {@code POST /act}. Game-side behaviour needs a live client and is covered by
 * the agent-engine's mock-server tests plus live runs.
 */
public class ActHandlerTest {

	private HttpServer server;
	private int port;
	private final Gson gson = new Gson();

	@Before
	public void setUp() throws Exception {
		Client client = mock(Client.class);
		when(client.getTickCount()).thenReturn(1234);
		server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
		server.createContext("/act", new ActHandler(gson, client));
		AgentHandler.setTokenSupplier(() -> "t");
		server.start();
		port = server.getAddress().getPort();
	}

	@After
	public void tearDown() {
		if (server != null) server.stop(0);
		AgentHandler.setTokenSupplier(null);
	}

	private HttpURLConnection request(String method, String body) throws Exception {
		HttpURLConnection conn = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/act").openConnection();
		conn.setRequestMethod(method);
		conn.setRequestProperty("X-Agent-Token", "t");
		if (body != null) {
			conn.setDoOutput(true);
			conn.setRequestProperty("Content-Type", "application/json");
			try (OutputStream os = conn.getOutputStream()) {
				os.write(body.getBytes(StandardCharsets.UTF_8));
			}
		}
		return conn;
	}

	@SuppressWarnings("unchecked")
	private Map<String, Object> json(HttpURLConnection conn) throws Exception {
		InputStream in = conn.getResponseCode() >= 400 ? conn.getErrorStream() : conn.getInputStream();
		return gson.fromJson(new String(in.readAllBytes(), StandardCharsets.UTF_8), Map.class);
	}

	@Test
	public void getIsRejected() throws Exception {
		HttpURLConnection conn = request("GET", null);
		assertEquals(405, conn.getResponseCode());
	}

	@Test
	public void missingOpIsBadRequest() throws Exception {
		HttpURLConnection conn = request("POST", "{\"target\":{}}");
		assertEquals(400, conn.getResponseCode());
		assertTrue(String.valueOf(json(conn).get("error")).contains("op"));
	}

	@Test
	public void unknownOpIsBadRequestEvenWhenLoggedOut() throws Exception {
		HttpURLConnection conn = request("POST", "{\"op\":\"teleport_anywhere\"}");
		assertEquals(400, conn.getResponseCode());
		assertTrue(String.valueOf(json(conn).get("error")).contains("Unknown op"));
	}

	@Test
	public void knownOpWhileLoggedOutReportsReason() throws Exception {
		HttpURLConnection conn = request("POST", "{\"op\":\"bank_open\"}");
		assertEquals(200, conn.getResponseCode());
		Map<String, Object> body = json(conn);
		assertEquals(Boolean.FALSE, body.get("success"));
		assertEquals("not_logged_in", body.get("reason"));
		assertEquals("bank_open", body.get("op"));
		assertEquals(1234.0, body.get("tick"));
	}
}
