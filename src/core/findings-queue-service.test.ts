import { describe, expect, it, vi } from "vitest";
import {
  createFindingsQueueService,
  RemediationQueueQueryError,
} from "./findings-queue-service";

describe("findings queue service", () => {
  it("parses the request URL and loads the remediation queue", () => {
    const query = { sort: "recommended" as const, limit: 100, offset: 0 };
    const payload = {
      findings: [{ findingId: "f-1" }],
      counts: { total: 1 },
      limit: 100,
      offset: 0,
    };
    const parseQuery = vi.fn(() => query);
    const loadQueue = vi.fn(() => payload);
    const service = createFindingsQueueService({
      parseQuery,
      loadQueue,
    } as unknown as Parameters<typeof createFindingsQueueService>[0]);
    const url = new URL("http://127.0.0.1/findings/queue?limit=100");

    expect(service.load(url)).toEqual(payload);
    expect(parseQuery).toHaveBeenCalledWith(url);
    expect(loadQueue).toHaveBeenCalledWith(query);
  });

  it("propagates invalid query errors", () => {
    const parseQuery = vi.fn(() => {
      throw new RemediationQueueQueryError("Invalid sort order");
    });
    const loadQueue = vi.fn();
    const service = createFindingsQueueService({
      parseQuery,
      loadQueue,
    } as unknown as Parameters<typeof createFindingsQueueService>[0]);

    expect(() => service.load(new URL("http://127.0.0.1/findings/queue?sort=bad"))).toThrow(
      RemediationQueueQueryError,
    );
    expect(loadQueue).not.toHaveBeenCalled();
  });
});
