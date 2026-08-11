import type { SessionEvent } from "@anicode/core";

type AgentEvent = Extract<SessionEvent, { type: "agent" }>["event"];
type StreamDelta = Extract<AgentEvent, { type: "text" | "thinking" | "tool_input_delta" }>;
type StreamDeltaSessionEvent = { type: "agent"; event: StreamDelta };

function streamKey(event: SessionEvent): string | undefined {
  if (event.type !== "agent") return undefined;
  const delta = event.event;
  if (delta.type === "text" || delta.type === "thinking") return delta.type;
  if (delta.type === "tool_input_delta") {
    return `${delta.type}\0${delta.id}\0${delta.name}`;
  }
  return undefined;
}

export function isStreamDeltaEvent(event: SessionEvent): event is StreamDeltaSessionEvent {
  return streamKey(event) !== undefined;
}

/**
 * Merge only adjacent, semantically identical stream deltas. Event boundaries such as reset,
 * tool_start and permission requests remain in their original order.
 */
export function coalesceSessionEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const output: SessionEvent[] = [];
  let pending:
    { key: string; first: Extract<SessionEvent, { type: "agent" }>; chunks: string[] } | undefined;

  const flush = (): void => {
    if (!pending) return;
    if (pending.chunks.length === 1) {
      output.push(pending.first);
      pending = undefined;
      return;
    }
    const event = pending.first.event as StreamDelta;
    const value = pending.chunks.join("");
    output.push({
      type: "agent",
      event:
        event.type === "tool_input_delta" ? { ...event, delta: value } : { ...event, text: value },
    });
    pending = undefined;
  };

  for (const event of events) {
    const key = streamKey(event);
    if (key === undefined || !isStreamDeltaEvent(event)) {
      flush();
      output.push(event);
      continue;
    }
    const value = event.event.type === "tool_input_delta" ? event.event.delta : event.event.text;
    if (pending?.key === key) {
      pending.chunks.push(value);
      continue;
    }
    flush();
    pending = { key, first: event, chunks: [value] };
  }
  flush();
  return output;
}
