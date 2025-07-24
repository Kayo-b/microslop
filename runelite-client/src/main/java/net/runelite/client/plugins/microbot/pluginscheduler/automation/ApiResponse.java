package net.runelite.client.plugins.microbot.pluginscheduler.automation;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class ApiResponse {
    private boolean success;
    private String message;
    private int count;
    private Object data;

    public ApiResponse(boolean success, String message, int count) {
        this.success = success;
        this.message = message;
        this.count = count;
        this.data = null;
    }
}
