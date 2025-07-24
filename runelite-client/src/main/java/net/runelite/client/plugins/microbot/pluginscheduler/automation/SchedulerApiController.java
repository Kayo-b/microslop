package net.runelite.client.plugins.microbot.pluginscheduler.automation;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import lombok.extern.slf4j.Slf4j;
import net.runelite.client.plugins.microbot.Microbot;
import net.runelite.client.plugins.microbot.pluginscheduler.SchedulerPlugin;
import net.runelite.client.plugins.microbot.pluginscheduler.SchedulerState;
import net.runelite.client.plugins.microbot.pluginscheduler.model.PluginScheduleEntry;

import javax.swing.SwingUtilities;
import java.util.List;

@Slf4j
public class SchedulerApiController {
    private final SchedulerPlugin schedulerPlugin;
    private final Gson gson = new Gson();
    public static final String VERSION = "0.1.0";
    
    public SchedulerApiController(SchedulerPlugin schedulerPlugin) {
        this.schedulerPlugin = schedulerPlugin;
    }


    public ApiResponse loadScheduleFromJson(String json) {
        try {

            List<PluginScheduleEntry> loadedPlugins = 
            PluginScheduleEntry.fromJson(json, this.VERSION); 

            if (loadedPlugins == null) {
                log.error("Failed to parse JSON from file");
                return new ApiResponse(false, "Failed to parse JSON from file",0);
            }

            // Resolve plugin references
            for (PluginScheduleEntry entry : loadedPlugins) {

                schedulerPlugin.resolvePluginReferences(entry);

                // Register stop completion callback
                schedulerPlugin.registerStopCompletionCallback(entry);
            }
            
            // Replace current plugins
            schedulerPlugin.updateScheduledPluginFromJson(loadedPlugins);

            // Update UI
            SwingUtilities.invokeLater(() -> schedulerPlugin.updatePanels());
            
            Microbot.log("Loaded " + loadedPlugins.size() + " schedule entries from JSON");
            log.info("Successfully loaded {} schedule entries from JSON", loadedPlugins.size());
            
            return new ApiResponse(true, "Schedule loaded successfully", loadedPlugins.size());
        } catch (Exception e) {
            log.error("Failed to load schedule from JSON: {}", e.getMessage(), e);
            return new ApiResponse(false, "Failed to load schedule: " + e.getMessage(), 0);
        }
    }
    
    public ApiResponse addScheduleEntryFromJson(String jsonContent) {
        try {
            PluginScheduleEntry entry = gson.fromJson(jsonContent, PluginScheduleEntry.class);
            
            if (entry == null) {
                return new ApiResponse(false, "Invalid schedule entry JSON", 0);
            }
            
            schedulerPlugin.getScheduledPlugins().add(entry);
            schedulerPlugin.saveScheduledPlugins();
            
            Microbot.log("Added schedule entry: " + entry.getName());
            log.info("Successfully added schedule entry: {}", entry.getName());
            
            return new ApiResponse(true, "Schedule entry added successfully", 1);
        } catch (Exception e) {
            log.error("Failed to add schedule entry from JSON: {}", e.getMessage(), e);
            return new ApiResponse(false, "Failed to add schedule entry: " + e.getMessage(), 0);
        }
    }
    
    public ApiResponse startScheduler() {
        try {
            schedulerPlugin.startScheduler();
            Microbot.log("Scheduler started via automation API");
            log.info("Scheduler started via automation API");
            return new ApiResponse(true, "Scheduler started", 0);
        } catch (Exception e) {
            log.error("Failed to start scheduler: {}", e.getMessage(), e);
            return new ApiResponse(false, "Failed to start scheduler: " + e.getMessage(), 0);
        }
    }
    
    public ApiResponse stopScheduler() {
        try {
            schedulerPlugin.stopScheduler();
            Microbot.log("Scheduler stopped via automation API");
            log.info("Scheduler stopped via automation API");
            return new ApiResponse(true, "Scheduler stopped", 0);
        } catch (Exception e) {
            log.error("Failed to stop scheduler: {}", e.getMessage(), e);
            return new ApiResponse(false, "Failed to stop scheduler: " + e.getMessage(), 0);
        }
    }
    
    public ApiResponse pauseScheduler() {
        try {
            boolean wasPaused = schedulerPlugin.pauseScheduler();
            String message = wasPaused ? "Scheduler was already paused" : "Scheduler paused";
            Microbot.log(message + " via automation API");
            log.info(message + " via automation API");
            return new ApiResponse(true, message, 0);
        } catch (Exception e) {
            log.error("Failed to pause scheduler: {}", e.getMessage(), e);
            return new ApiResponse(false, "Failed to pause scheduler: " + e.getMessage(), 0);
        }
    }
    
    public ApiResponse resumeScheduler() {
        try {
            schedulerPlugin.resumeScheduler();
            Microbot.log("Scheduler resumed via automation API");
            log.info("Scheduler resumed via automation API");
            return new ApiResponse(true, "Scheduler resumed", 0);
        } catch (Exception e) {
            log.error("Failed to resume scheduler: {}", e.getMessage(), e);
            return new ApiResponse(false, "Failed to resume scheduler: " + e.getMessage(), 0);
        }
    }
    
    public ApiResponse getStatus() {
        try {
            SchedulerStatus status = new SchedulerStatus();
            status.setState(schedulerPlugin.getCurrentState());
            status.setCurrentPlugin(schedulerPlugin.getCurrentPlugin());
            status.setUpcomingPlugin(schedulerPlugin.getUpComingPlugin());
            status.setScheduledPluginCount(schedulerPlugin.getScheduledPlugins().size());
            status.setPaused(schedulerPlugin.isPaused());
            
            return new ApiResponse(true, "Status retrieved", 0, status);
        } catch (Exception e) {
            log.error("Failed to get scheduler status: {}", e.getMessage(), e);
            return new ApiResponse(false, "Failed to get status: " + e.getMessage(), 0);
        }
    }
    
    public ApiResponse clearAllSchedules() {
        try {
            int count = schedulerPlugin.getScheduledPlugins().size();
            schedulerPlugin.getScheduledPlugins().clear();
            schedulerPlugin.saveScheduledPlugins();
            
            Microbot.log("Cleared " + count + " schedule entries via automation API");
            log.info("Cleared {} schedule entries via automation API", count);
            
            return new ApiResponse(true, "All schedules cleared", count);
        } catch (Exception e) {
            log.error("Failed to clear schedules: {}", e.getMessage(), e);
            return new ApiResponse(false, "Failed to clear schedules: " + e.getMessage(), 0);
        }
    }
    
    // inner class for status response
    public static class SchedulerStatus {
        private SchedulerState state;
        private PluginScheduleEntry currentPlugin;
        private PluginScheduleEntry upcomingPlugin;
        private int scheduledPluginCount;
        private boolean paused;
        
        //getters and setters
        public SchedulerState getState() { return state; }
        public void setState(SchedulerState state) { this.state = state; }
        
        public PluginScheduleEntry getCurrentPlugin() { return currentPlugin; }
        public void setCurrentPlugin(PluginScheduleEntry currentPlugin) { this.currentPlugin = currentPlugin; }
        
        public PluginScheduleEntry getUpcomingPlugin() { return upcomingPlugin; }
        public void setUpcomingPlugin(PluginScheduleEntry upcomingPlugin) { this.upcomingPlugin = upcomingPlugin; }
        
        public int getScheduledPluginCount() { return scheduledPluginCount; }
        public void setScheduledPluginCount(int scheduledPluginCount) { this.scheduledPluginCount = scheduledPluginCount; }
        
        public boolean isPaused() { return paused; }
        public void setPaused(boolean paused) { this.paused = paused; }
    }
}
