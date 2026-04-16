import type { Database } from "../db/connection.js";
import {
  BaseFrameworkAdapter,
  createHandlerBackedMemoryClient,
  type AdapterSessionEndedEvent,
  type AdapterSessionStartedEvent,
  type MemoryToolClient,
} from "./base.js";

export interface OpenClawSessionStartedEvent
  extends AdapterSessionStartedEvent {
  framework: "openclaw";
}

export interface OpenClawSessionEndedEvent extends AdapterSessionEndedEvent {
  framework: "openclaw";
}

export interface OpenClawPostToolUseEvent {
  framework: "openclaw";
  type: "PostToolUse";
  sessionId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  importanceHint?: number;
}

export type OpenClawEvent =
  | OpenClawSessionStartedEvent
  | OpenClawSessionEndedEvent
  | OpenClawPostToolUseEvent;

export interface ClawHubSkill {
  name: string;
  version: string;
  initialize(): Promise<void>;
  canHandle(event: unknown): boolean;
  onSessionStart(event: OpenClawSessionStartedEvent): Promise<unknown>;
  onPostToolUse(event: OpenClawPostToolUseEvent): Promise<unknown>;
  onSessionEnd(event: OpenClawSessionEndedEvent): Promise<unknown>;
  shutdown(): Promise<void>;
}

function isOpenClawEvent(event: unknown): event is OpenClawEvent {
  if (typeof event !== "object" || event === null) {
    return false;
  }

  const value = event as Record<string, unknown>;
  return (
    value.framework === "openclaw" &&
    (value.type === "session.started" ||
      value.type === "session.ended" ||
      value.type === "PostToolUse")
  );
}

export class OpenClawAdapter extends BaseFrameworkAdapter<OpenClawEvent> {
  constructor(
    db: Database,
    client: MemoryToolClient = createHandlerBackedMemoryClient(db)
  ) {
    super(db, client, "openclaw");
  }

  canHandle(event: unknown): event is OpenClawEvent {
    return isOpenClawEvent(event);
  }

  protected async handleEvent(event: OpenClawEvent): Promise<unknown> {
    if (event.type === "session.started") {
      const session = this.createSession(event);
      return {
        status: "session_started",
        session_id: session.sessionId,
        scope: session.scope,
      };
    }

    if (event.type === "session.ended") {
      this.endSession(event.sessionId);
      return {
        status: "session_ended",
        session_id: event.sessionId,
      };
    }

    const session = this.requireSession(event.sessionId);
    const scope = this.detectScope(session.projectId);
    const content = this.buildToolMemoryContent(
      event.toolName,
      event.input,
      event.output,
      "OpenClaw tool"
    );

    const result = await this.bufferAndRemember({
      content,
      agentId: session.agentId,
      userId: session.userId,
      sessionId: session.sessionId,
      scope,
      ...(session.projectId !== undefined ? { projectId: session.projectId } : {}),
      ...(event.importanceHint !== undefined
        ? { importanceHint: event.importanceHint }
        : {}),
      sourceType: "adapter:openclaw:post-tool-use",
    });

    return {
      status: "captured",
      memcell_id: result.remembered.memcell_id,
      scope,
      ...(session.projectId !== undefined ? { project_id: session.projectId } : {}),
      candidates_buffered: result.candidatesBuffered,
    };
  }
}

export function createClawHubSkill(adapter: OpenClawAdapter): ClawHubSkill {
  return {
    name: "memryon-openclaw",
    version: "0.1.0",
    initialize: () => adapter.initialize(),
    canHandle: (event) => adapter.canHandle(event),
    onSessionStart: (event) => adapter.onEvent(event),
    onPostToolUse: (event) => adapter.onEvent(event),
    onSessionEnd: (event) => adapter.onEvent(event),
    shutdown: () => adapter.shutdown(),
  };
}
