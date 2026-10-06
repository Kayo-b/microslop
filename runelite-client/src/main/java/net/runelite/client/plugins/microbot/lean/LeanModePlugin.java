package net.runelite.client.plugins.microbot.lean;

import javax.inject.Inject;
import lombok.extern.slf4j.Slf4j;
import net.runelite.api.Renderable;
import net.runelite.api.Scene;
import net.runelite.api.Tile;
import net.runelite.api.TileObject;
import net.runelite.client.callback.RenderCallback;
import net.runelite.client.callback.RenderCallbackManager;
import net.runelite.client.config.ConfigManager;
import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;
import javax.swing.SwingUtilities;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;
import net.runelite.client.plugins.PluginManager;

/**
 * Lean mode for running several bot clients on one machine. Off unless the JVM is started with
 * {@code -Dmicrobot.lean=true}; then:
 * <ul>
 *   <li>{@code -Dmicrobot.lean.noRender=true}: skips drawing every scene tile, object and world
 *   entity through the render callbacks, the costly part of a frame. Interfaces (inventory, bank,
 *   chat) are still drawn; game state, widgets and the agent server are unaffected. (Replacing the
 *   GPU draw hooks instead did not stop the software renderer.)</li>
 *   <li>{@code -Dmicrobot.lean.fps=N} (default 10): caps the client's frame rate via the FPS plugin.</li>
 *   <li>{@code -Dmicrobot.lean.disable=QuestHelperPlugin,...}: plugins (by class name) stopped for
 *   this client only; empty by default (quest runs need Quest Helper).</li>
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
	private static final RenderCallback NO_SCENE = new RenderCallback()
	{
		@Override
		public boolean addEntity(Renderable renderable, boolean ui)
		{
			// Entities drawn as part of the interface (item models in the inventory) stay.
			return ui;
		}

		@Override
		public boolean drawTile(Scene scene, Tile tile)
		{
			return false;
		}

		@Override
		public boolean drawObject(Scene scene, TileObject object)
		{
			return false;
		}
	};

	@Inject
	private RenderCallbackManager renderCallbackManager;

	@Inject
	private PluginManager pluginManager;

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
			renderCallbackManager.register(NO_SCENE);
		}
		Set<String> disable = Arrays.stream(System.getProperty("microbot.lean.disable", "").split(","))
			.map(String::trim).filter(n -> !n.isEmpty()).collect(Collectors.toSet());
		if (!disable.isEmpty())
		{
			SwingUtilities.invokeLater(() -> {
				for (Plugin p : pluginManager.getPlugins())
				{
					if (disable.contains(p.getClass().getSimpleName()) && pluginManager.isPluginEnabled(p))
					{
						pluginManager.setPluginEnabled(p, false);
						try
						{
							pluginManager.stopPlugin(p);
							log.info("Lean mode: stopped {}", p.getClass().getSimpleName());
						}
						catch (Exception e)
						{
							log.warn("Lean mode: could not stop {}", p.getClass().getSimpleName(), e);
						}
					}
				}
			});
		}
		log.info("Lean mode: fps cap {}, rendering {}", fps, Boolean.getBoolean("microbot.lean.noRender") ? "off" : "on");
	}

	@Override
	protected void shutDown()
	{
		renderCallbackManager.unregister(NO_SCENE);
	}
}
