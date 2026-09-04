import type { FlowEvent } from "../agents/types";

const encoder = new TextEncoder();

export function encodeFlowEvent(event: FlowEvent) {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export class FlowEventParser {
  private buffer = "";

  push(chunk: string): FlowEvent[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const events: FlowEvent[] = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (data) events.push(JSON.parse(data) as FlowEvent);
      boundary = this.buffer.indexOf("\n\n");
    }
    return events;
  }
}
