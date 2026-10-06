package net.runelite.client.plugins.microbot.lean;

import javax.inject.Inject;
import lombok.extern.slf4j.Slf4j;
import net.runelite.api.Client;
import net.runelite.api.Scene;
import net.runelite.api.hooks.DrawCallbacks;
import net.runelite.client.callback.ClientThread;
import net.runelite.client.config.ConfigManager;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;

/**
 * Lean mode for running several bot clients on one machine. Off unless the JVM is started with
 * {@code -Dmicrobot.lean=true}; then:
 * <ul>
 *   <li>{@code -Dmicrobot.lean.noRender=true}: takes over the GPU draw hooks with no-ops, so the 3D
 *   scene and the interface are never rasterised (the window stays blank; game state, widgets and
 *   the agent server are unaffected).</li>
 *   <li>{@code -Dmicrobot.lean.fps=N} (default 10): caps the client's frame rate via the FPS plugin.</li>
 * </ul>
 */
@PluginDescriptor(
	name = "Lean Mode",
	description = "Low CPU/RAM mode for running several clients (enabled with -Dmicrobot.lean=true)",
	hidden = true,
	enabledByDefault = true
)
@Slf4j
public class LeanModePlugin extends Plugin
{
	private static final DrawCallbacks NO_RENDER = new DrawCallbacks()
	{
		@Override
		public void draw(int overlayColor)
		{
		}

		@Override
		public void swapScene(Scene scene)
		{
		}
	};

	@Inject
	private Client client;

	@Inject
	private ClientThread clientThread;

	@Inject
	private ConfigManager configManager;

	@Override
	protected void startUp()
	{
		if (!Boolean.getBoolean("microbot.lean"))
		{
			return;
		}
		int fps = Integer.getInteger("microbot.lean.fps", 10);
		configManager.setConfiguration("runelite", "fpsplugin", true);
		configManager.setConfiguration("fpscontrol", "limitFps", true);
		configManager.setConfiguration("fpscontrol", "maxFps", fps);
		configManager.setConfiguration("fpscontrol", "limitFpsUnfocused", true);
		configManager.setConfiguration("fpscontrol", "maxFpsUnfocused", fps);
		if (Boolean.getBoolean("microbot.lean.noRender"))
		{
			clientThread.invokeLater(() -> {
				client.setDrawCallbacks(NO_RENDER);
				client.setGpuFlags(DrawCallbacks.GPU);
			});
		}
		log.info("Lean mode: fps cap {}, rendering {}", fps, Boolean.getBoolean("microbot.lean.noRender") ? "off" : "on");
	}

	@Override
	protected void shutDown()
	{
		if (Boolean.getBoolean("microbot.lean.noRender"))
		{
			clientThread.invokeLater(() -> {
				if (client.getDrawCallbacks() == NO_RENDER)
				{
					client.setGpuFlags(0);
					client.setDrawCallbacks(null);
				}
			});
		}
	}
}
