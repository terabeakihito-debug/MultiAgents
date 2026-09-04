import { describe, expect, it } from "vitest";
import type { FlowEvent } from "../agents/types";
import { encodeFlowEvent, FlowEventParser } from "./sse";

describe("flow event SSE", () => {
  it("parses events split across arbitrary chunks", () => {
    const event: FlowEvent = { type: "flow_started", flowId: "flow-1", timestamp: "2026-01-01T00:00:00.000Z" };
    const encoded = new TextDecoder().decode(encodeFlowEvent(event));
    const parser = new FlowEventParser();
    expect(parser.push(encoded.slice(0, 8))).toEqual([]);
    expect(parser.push(encoded.slice(8))).toEqual([event]);
  });
});
