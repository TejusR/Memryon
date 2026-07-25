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

export interface OpenClawPromptEvent {
  framework: "openclaw";
  type: "agent_turn_prepare" | "before_prompt_build";
  sessionId: string;
  agentId: string;
  userId: string;
  projectId?: string;
  prompt: string;
}

export interface OpenClawBeforeFinalizeEvent {
  framework: "openclaw";
  type: "before_agent_finalize";
  sessionId: string;
  response?: string;
}

export type OpenClawEvent =
  | OpenClawSessionStartedEvent
  | OpenClawSessionEndedEvent
  | OpenClawPostToolUseEvent
  | OpenClawPromptEvent
  | OpenClawBeforeFinalizeEvent;

export interface OpenClawAdapterOptions {
  captureToolActivity?: boolean;
}

export interface ClawHubSkill {
  name: string;
  version: string;
  initialize(): Promise<void>;
  canHandle(event: unknown): boolean;
  onSessionStart(event: OpenClawSessionStartedEvent): Promise<unknown>;
  onPostToolUse(event: OpenClawPostToolUseEvent): Promise<unknown>;
  onAgentTurnPrepare(event: OpenClawPromptEvent): Promise<unknown>;
  onBeforePromptBuild(event: OpenClawPromptEvent): Promise<unknown>;
  onBeforeAgentFinalize(event: OpenClawBeforeFinalizeEvent): Promise<unknown>;
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
      value.type === "PostToolUse" ||
      value.type === "agent_turn_prepare" ||
      value.type === "before_prompt_build" ||
      value.type === "before_agent_finalize")
  );
}

export class OpenClawAdapter extends BaseFrameworkAdapter<OpenClawEvent> {
  constructor(
    db: Database,
    client: MemoryToolClient = createHandlerBackedMemoryClient(db),
    private readonly options: OpenClawAdapterOptions = {}
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

    if (
      event.type === "agent_turn_prepare" ||
      event.type === "before_prompt_build"
    ) {
      let session = this.getSession(event.sessionId);
      if (session === undefined) {
        session = this.createSession({
          type: "session.started",
          sessionId: event.sessionId,
          agentId: event.agentId,
          userId: event.userId,
          ...(event.projectId !== undefined
            ? { projectId: event.projectId }
            : {}),
        });
      }
      session.currentTask = event.prompt;
      const context = await this.prepareForTask(
        event.prompt,
        session.userId,
        session.agentId,
        session.sessionId,
        session.projectId
      );
      session.injectedContext = context;
      return { prependContext: context };
    }

    if (event.type === "before_agent_finalize") {
      const session = this.requireSession(event.sessionId);
      const substantive =
        session.substantiveActivity === true ||
        (event.response?.trim().length ?? 0) >= 200;
      if (
        !substantive ||
        session.stopReminderIssued === true ||
        this.hasRecordedHandoff(session.sessionId, session.agentId)
      ) {
        return { action: "finalize" };
      }
      session.stopReminderIssued = true;
      return {
        action: "revise",
        reason: "A substantive task needs a structured Memryon handoff.",
        retry: {
          instruction:
            "Call record_handoff once with concise decisions, constraints, failures, outcomes, and unresolved questions, then provide the final answer. Never store hidden reasoning.",
          idempotencyKey: `memryon-handoff-${session.sessionId}`,
          maxAttempts: 1,
        },
      };
    }

    if (event.type !== "PostToolUse") {
      return { status: "ignored" };
    }

    const session = this.requireSession(event.sessionId);
    session.substantiveActivity = true;
    const scope = this.detectScope(session.projectId);
    if (this.options.captureToolActivity !== true) {
      return {
        status: "ignored",
        scope,
        capture_tool_activity: false,
      };
    }

    const content = this.buildToolMemoryContent(
      event.toolName,
      event.input,
      event.output,
      "OpenClaw tool"
    );

    const captureInput = {
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
    };

    return {
      status: "buffered",
      scope,
      ...(session.projectId !== undefined ? { project_id: session.projectId } : {}),
      candidates_buffered: this.bufferCandidateActivity(captureInput),
    };
  }

  private async prepareForTask(
    task: string,
    userId: string,
    agentId: string,
    sessionId: string,
    projectId?: string
  ): Promise<string> {
    if (this.client.prepareContext === undefined) {
      return "";
    }
    try {
      const result = await this.client.prepareContext({
        task,
        user_id: userId,
        agent_id: agentId,
        session_id: sessionId,
        ...(projectId !== undefined ? { project_id: projectId } : {}),
      });
      return result.context;
    } catch (error) {
      this.recordError("prepare_context", error);
      return "[Memryon warning: relevant context could not be loaded. Continuing without it.]";
    }
  }

  private hasRecordedHandoff(sessionId: string, agentId: string): boolean {
    return (
      this.db
        .prepare<[string, string], { present: number }>(
          `SELECT 1 AS present
           FROM handoffs
           WHERE session_id = ? AND agent_id = ?
           LIMIT 1`
        )
        .get(sessionId, agentId) !== undefined
    );
  }
}

/**
 * Adapts an OpenClaw adapter instance into the ClawHub skill contract.
 */
export function createClawHubSkill(adapter: OpenClawAdapter): ClawHubSkill {
  return {
    name: "memryon-openclaw",
    version: "0.1.0",
    initialize: () => adapter.initialize(),
    canHandle: (event) => adapter.canHandle(event),
    onSessionStart: (event) => adapter.onEvent(event),
    onPostToolUse: (event) => adapter.onEvent(event),
    onAgentTurnPrepare: (event) => adapter.onEvent(event),
    onBeforePromptBuild: (event) => adapter.onEvent(event),
    onBeforeAgentFinalize: (event) => adapter.onEvent(event),
    onSessionEnd: (event) => adapter.onEvent(event),
    shutdown: () => adapter.shutdown(),
  };
}
