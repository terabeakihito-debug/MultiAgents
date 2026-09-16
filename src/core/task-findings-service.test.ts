import { describe, expect, it, vi } from "vitest";
import type { Finding, FindingEvent } from "../findings/types";
import {
  createTaskFindingsService,
  TaskFindingsLoadError,
} from "./task-findings-service";

const finding = {
  findingId: "11111111-1111-4111-8111-111111111111",
  sourceTaskId: "task-1",
  title: "Open redirect",
  summary: "User-controlled URL",
  severity: "high",
  status: "open",
  humanPriority: "normal",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as Finding;

const remediation = { findingId: finding.findingId, stage: "accepted" };
const history = [{ type: "finding_created" }] as FindingEvent[];

function dependencies(overrides: Partial<{
  initializeRecovery: () => Promise<void>;
  list: (id: string) => Finding[];
  getRemediation: (findingId: string) => typeof remediation;
  loadHistory: (findingId: string) => FindingEvent[];
}> = {}) {
  return {
    initializeRecovery: vi.fn(async () => undefined),
    list: vi.fn(() => [finding]),
    getRemediation: vi.fn(() => remediation),
    loadHistory: vi.fn(() => history),
    ...overrides,
  };
}

describe("task findings service", () => {
  it("initializes recovery before listing and projects remediation plus history", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      initializeRecovery: vi.fn(async () => { calls.push("recovery"); }),
      list: vi.fn((id: string) => { calls.push(`list:${id}`); return [finding]; }),
    });
    const service = createTaskFindingsService(
      deps as unknown as Parameters<typeof createTaskFindingsService>[0],
    );

    await expect(service.load("task-1")).resolves.toEqual({
      findings: [{ ...finding, remediation, history }],
    });
    expect(calls).toEqual(["recovery", "list:task-1"]);
    expect(deps.getRemediation).toHaveBeenCalledWith(finding.findingId);
    expect(deps.loadHistory).toHaveBeenCalledWith(finding.findingId);
  });

  it("maps listing failures to TaskFindingsLoadError", async () => {
    const deps = dependencies({
      list: vi.fn(() => {
        throw new Error("Source task not found");
      }),
    });
    const service = createTaskFindingsService(
      deps as unknown as Parameters<typeof createTaskFindingsService>[0],
    );

    await expect(service.load("missing")).rejects.toMatchObject({
      name: "TaskFindingsLoadError",
      message: "Source task not found",
    });
    await expect(service.load("missing")).rejects.toBeInstanceOf(TaskFindingsLoadError);
    expect(deps.getRemediation).not.toHaveBeenCalled();
  });

  it("maps unknown listing failures to the established fallback message", async () => {
    const deps = dependencies({
      list: vi.fn(() => {
        throw { unexpected: true };
      }),
    });
    const service = createTaskFindingsService(
      deps as unknown as Parameters<typeof createTaskFindingsService>[0],
    );

    await expect(service.load("task-1")).rejects.toMatchObject({
      name: "TaskFindingsLoadError",
      message: "Could not load findings",
    });
  });
});
