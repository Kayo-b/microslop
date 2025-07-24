package net.runelite.client.plugins.microbot.pluginscheduler.automation;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import lombok.extern.slf4j.Slf4j;
import net.runelite.client.plugins.microbot.Microbot;
import net.runelite.client.plugins.microbot.pluginscheduler.SchedulerPlugin;

import java.io.*;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

@Slf4j
public class SocketAutomationManager {
    private int DEFAULT_PORT = 45678;
    private static final String SCHEDULES_DIR = System.getProperty("user.home") + "/.microbot/schedules";
    
    // private final SchedulerPlugin schedulerPlugin; // used only for initialization
    private final SchedulerApiController apiController;
    private final Gson gson = new Gson();
    
    private ServerSocket serverSocket;
    private boolean running = false;
    private Thread socketThread;

    public SocketAutomationManager(SchedulerPlugin schedulerPlugin) {
        // this.schedulerPlugin = schedulerPlugin; // used only for initialization
        this.apiController = new SchedulerApiController(schedulerPlugin);
        
        // ensure schedules directory exists
        createSchedulesDirectory();
    }

    public void startSocketListener() {
        if (running) {
            log.warn("Socket automation manager is already running on port {}", DEFAULT_PORT);
            Microbot.log("Socket automation manager is already running on port " + DEFAULT_PORT);
            return;
        }

        socketThread = new Thread(() -> {
            try {
                serverSocket = new ServerSocket(DEFAULT_PORT);
                running = true;
                Microbot.log("Socket automation listener started on port " + DEFAULT_PORT);
                log.info("Socket automation listener started on port {}", DEFAULT_PORT);
                
                while (running && !Thread.currentThread().isInterrupted()) {
                    try {
                        Socket client = serverSocket.accept();
                        // handle each client connection in a separate thread
                        new Thread(() -> handleClientConnection(client)).start();
                    } catch (IOException e) {
                        if (running) {
                            log.error("Error accepting client connection: {}", e.getMessage());
                        }
                        // continue listening for other connections
                    }
                }
            } catch (IOException e) {
                if (running) {
                    log.error("Socket automation server error: {}", e.getMessage());
                    Microbot.log("Socket automation server error: " + e.getMessage());
                }
            } finally {
                log.info("Socket automation listener stopped");
            }
        });
        
        socketThread.setName("SocketAutomationManager");
        socketThread.setDaemon(true);
        socketThread.start();
    }

    public ApiResponse startNewSocketListener() {
        try {
            // Find next available port
            int newPort = findNextAvailablePort(DEFAULT_PORT + 1);
            
            // Create new socket automation manager instance for the new port
            Thread newSocketThread = new Thread(() -> {
                try {
                    ServerSocket newServerSocket = new ServerSocket(newPort);
                    Microbot.log("New socket automation listener started on port " + newPort);
                    log.info("New socket automation listener started on port {}", newPort);
                    
                    while (!Thread.currentThread().isInterrupted()) {
                        try {
                            Socket client = newServerSocket.accept();
                            new Thread(() -> handleClientConnection(client)).start();
                        } catch (IOException e) {
                            if (!Thread.currentThread().isInterrupted()) {
                                log.error("Error accepting client connection on port {}: {}", newPort, e.getMessage());
                            }
                            break;
                        }
                    }
                } catch (IOException e) {
                    log.error("Failed to start socket automation server on port {}: {}", newPort, e.getMessage());
                } finally {
                    log.info("Socket automation listener on port {} stopped", newPort);
                }
            });
            
            newSocketThread.setName("SocketAutomationManager-" + newPort);
            newSocketThread.setDaemon(true);
            newSocketThread.start();
            
            return new ApiResponse(true, "New socket listener started on port " + newPort, newPort);
            
        } catch (Exception e) {
            log.error("Failed to start new socket listener: {}", e.getMessage(), e);
            return new ApiResponse(false, "Failed to start new socket listener: " + e.getMessage(), 0);
        }
    }

    private int findNextAvailablePort(int startPort) {
        int port = startPort;
        while (port < 65535) {
            try (ServerSocket testSocket = new ServerSocket(port)) {
                return port;
            } catch (IOException e) {
                port++;
            }
        }
        throw new RuntimeException("No available ports found starting from " + startPort);
    }

    private ApiResponse getSocketInfo() {
        try {
            JsonObject info = new JsonObject();
            info.addProperty("mainPort", DEFAULT_PORT);
            info.addProperty("isMainSocketRunning", isRunning());
            info.addProperty("schedulesDirectory", SCHEDULES_DIR);
            
            return new ApiResponse(true, "Socket information retrieved", 1, info);
            
        } catch (Exception e) {
            log.error("Error getting socket info: {}", e.getMessage(), e);
            return new ApiResponse(false, "Failed to get socket info: " + e.getMessage(), 0);
        }
    }

    private void handleClientConnection(Socket client) {
        try (BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream()));
             PrintWriter out = new PrintWriter(client.getOutputStream(), true)) {
            
            String request = in.readLine();
            if (request != null && !request.trim().isEmpty()) {
                log.debug("Received automation request: {}", request);
                
                ApiResponse response = processAutomationCommand(request);
                String responseJson = gson.toJson(response);
                
                out.println(responseJson);
                log.debug("Sent response: {}", responseJson);
            } else {
                ApiResponse errorResponse = new ApiResponse(false, "Empty request received", 0);
                out.println(gson.toJson(errorResponse));
            }
            
        } catch (Exception e) {
            log.error("Error handling automation request: {}", e.getMessage(), e);
            try (PrintWriter out = new PrintWriter(client.getOutputStream(), true)) {
                ApiResponse errorResponse = new ApiResponse(false, "Internal error: " + e.getMessage(), 0);
                out.println(gson.toJson(errorResponse));
            } catch (IOException ioException) {
                log.error("Error sending error response: {}", ioException.getMessage());
            }
        } finally {
            try {
                client.close();
            } catch (IOException e) {
                log.debug("Error closing client connection: {}", e.getMessage());
            }
        }
    }

    private ApiResponse processAutomationCommand(String request) {
        try {
            JsonObject command = gson.fromJson(request, JsonObject.class);
            
            if (!command.has("action")) {
                return new ApiResponse(false, "Missing 'action' field in request", 0);
            }
            
            String action = command.get("action").getAsString();
            
            switch (action) {
                case "load_schedule_file":
                    return loadScheduleFromFile(command);
                case "load_schedule_json":
                    return loadScheduleFromJson(command);
                case "start_scheduler":
                    return apiController.startScheduler();
                case "stop_scheduler":
                    return apiController.stopScheduler();
                case "pause_scheduler":
                    return apiController.pauseScheduler();
                case "resume_scheduler":
                    return apiController.resumeScheduler();
                case "get_status":
                    return apiController.getStatus();
                case "list_schedules":
                    return listAvailableScheduleFiles();
                case "clear_schedules":
                    return apiController.clearAllSchedules();
                case "add_schedule_entry":
                    return addScheduleEntry(command);
                case "start_new_socket":
                    return startNewSocketListener();
                case "get_socket_info":
                    return getSocketInfo();
                default:
                    return new ApiResponse(false, "Unknown action: " + action, 0);
            }
        } catch (Exception e) {
            log.error("Error processing automation command: {}", e.getMessage(), e);
            return new ApiResponse(false, "Error processing command: " + e.getMessage(), 0);
        }
    }

    private ApiResponse loadScheduleFromFile(JsonObject command) {
        try {
            if (!command.has("filename")) {
                return new ApiResponse(false, "Missing 'filename' field", 0);
            }
            
            String filename = command.get("filename").getAsString();
            Path filePath = Paths.get(SCHEDULES_DIR, filename);
            
            if (!Files.exists(filePath)) {
                return new ApiResponse(false, "Schedule file not found: " + filename, 0);
            }
            
            String content = Files.readString(filePath);
            return apiController.loadScheduleFromJson(content);
            
        } catch (Exception e) {
            log.error("Error loading schedule from file: {}", e.getMessage(), e);
            return new ApiResponse(false, "Failed to load schedule file: " + e.getMessage(), 0);
        }
    }

    private ApiResponse loadScheduleFromJson(JsonObject command) {
        try {
            if (!command.has("schedule")) {
                return new ApiResponse(false, "Missing 'schedule' field", 0);
            }
            
            String scheduleJson = command.get("schedule").getAsString();
            return apiController.loadScheduleFromJson(scheduleJson);
            
        } catch (Exception e) {
            log.error("Error loading schedule from JSON: {}", e.getMessage(), e);
            return new ApiResponse(false, "Failed to load schedule from JSON: " + e.getMessage(), 0);
        }
    }

    private ApiResponse addScheduleEntry(JsonObject command) {
        try {
            if (!command.has("entry")) {
                return new ApiResponse(false, "Missing 'entry' field", 0);
            }
            
            String entryJson = command.get("entry").getAsJsonObject().toString();
            return apiController.addScheduleEntryFromJson(entryJson);
            
        } catch (Exception e) {
            log.error("Error adding schedule entry: {}", e.getMessage(), e);
            return new ApiResponse(false, "Failed to add schedule entry: " + e.getMessage(), 0);
        }
    }

    private ApiResponse listAvailableScheduleFiles() {
        try {
            Path schedulesPath = Paths.get(SCHEDULES_DIR);
            if (!Files.exists(schedulesPath)) {
                return new ApiResponse(true, "No schedules directory found", 0, new String[0]);
            }
            
            String[] scheduleFiles = Files.list(schedulesPath)
                    .filter(path -> path.toString().toLowerCase().endsWith(".json"))
                    .map(path -> path.getFileName().toString())
                    .toArray(String[]::new);
            
            return new ApiResponse(true, "Schedule files listed", scheduleFiles.length, scheduleFiles);
            
        } catch (Exception e) {
            log.error("Error listing schedule files: {}", e.getMessage(), e);
            return new ApiResponse(false, "Failed to list schedule files: " + e.getMessage(), 0);
        }
    }

    private void createSchedulesDirectory() {
        try {
            Path schedulesPath = Paths.get(SCHEDULES_DIR);
            if (!Files.exists(schedulesPath)) {
                Files.createDirectories(schedulesPath);
                log.info("Created schedules directory: {}", SCHEDULES_DIR);
            }
        } catch (Exception e) {
            log.error("Failed to create schedules directory: {}", e.getMessage(), e);
        }
    }

    public void shutdown() {
        running = false;
        
        if (serverSocket != null && !serverSocket.isClosed()) {
            try {
                serverSocket.close();
            } catch (IOException e) {
                log.error("Error closing server socket: {}", e.getMessage());
            }
        }
        
        if (socketThread != null && socketThread.isAlive()) {
            socketThread.interrupt();
            try {
                socketThread.join(5000); 
            } catch (InterruptedException e) {
                log.debug("Interrupted while waiting for socket thread to finish");
                Thread.currentThread().interrupt();
            }
        }
        
        log.info("Socket automation manager shutdown complete");
    }

    public boolean isRunning() {
        return running && serverSocket != null && !serverSocket.isClosed();
    }

    public int getPort() {
        return DEFAULT_PORT;
    }

    public String getSchedulesDirectory() {
        return SCHEDULES_DIR;
    }
}
