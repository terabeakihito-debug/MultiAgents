import { describe, expect, it, vi } from "vitest";
import { createHumanSessionService } from "./human-session-service";

describe("human session service", () => {
  it("delegates to the shared human mutation nonce issuer", () => {
    const response = Response.json({ nonce: "test-nonce" });
    const issue = vi.fn(() => response);
    const service = createHumanSessionService(
      { issue } as unknown as Parameters<typeof createHumanSessionService>[0],
    );
    const request = new Request("http://127.0.0.1/human-session");

    expect(service.issue(request)).toBe(response);
    expect(issue).toHaveBeenCalledWith(request);
  });
});
