import { describe, expect, it, vi } from "vitest";
import { NotificationInputError } from "../server/notifications";
import { createNotificationPreferencesMutationService } from "./notification-preferences-mutation-service";

describe("notification preferences mutation service", () => {
  it("parses and saves preferences", () => {
    const parse = vi.fn(() => ({ taskInactive: false })) as never;
    const save = vi.fn(() => ({ taskInactive: false })) as never;
    const service = createNotificationPreferencesMutationService({
      parse,
      save,
    });

    expect(service.apply({ taskInactive: false })).toEqual({
      preferences: { taskInactive: false },
    });
    expect(parse).toHaveBeenCalledWith({ taskInactive: false });
    expect(save).toHaveBeenCalledWith({ taskInactive: false });
  });

  it("surfaces NotificationInputError from parsing", () => {
    const service = createNotificationPreferencesMutationService({
      parse: vi.fn(() => {
        throw new NotificationInputError("bad");
      }),
      save: vi.fn(),
    });

    expect(() => service.apply({})).toThrow(NotificationInputError);
  });
});
