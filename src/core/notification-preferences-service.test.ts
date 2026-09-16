import { describe, expect, it, vi } from "vitest";
import { createNotificationPreferencesService } from "./notification-preferences-service";

describe("notification preferences service", () => {
  it("returns stored notification preferences", () => {
    const preferences = { taskInactive: true, taskFailed: false };
    const loadPreferences = vi.fn(() => preferences);
    const service = createNotificationPreferencesService(
      { loadPreferences } as unknown as Parameters<typeof createNotificationPreferencesService>[0],
    );

    expect(service.load()).toEqual({ preferences });
    expect(loadPreferences).toHaveBeenCalledTimes(1);
  });
});
