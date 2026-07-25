import type { Database } from "../db/connection.js";
import type { ForgetResult } from "../mcp/tools/forget.js";
import type { RecallResult } from "../mcp/tools/recall.js";
import type { RememberResult } from "../mcp/tools/remember.js";
import type { PrepareContextResult } from "../mcp/tools/prepare-context.js";
import type {
  RecordHandoffArgs,
  RecordHandoffResult,
} from "../mcp/tools/record-handoff.js";
import {
  BaseFrameworkAdapter,
  createMcpToolClient,
  type AdapterSessionEndedEvent,
  type AdapterSessionStartedEvent,
  type CandidateScope,
  type ToolCaller,
} from "./base.js";

export interface CodexSessionStartedEvent extends AdapterSessionStartedEvent {
  framework: "codex";
}

export interface CodexSessionEndedEvent extends AdapterSessionEndedEvent {
  framework: "codex";
}

export interface CodexRememberEvent {
  framework: "codex";
  type: "remember";
  content: string;
  sessionId: string;
  agentId: string;
  userId: string;
  scope?: CandidateScope;
  projectId?: string;
  importanceHint?: number;
}

export interface CodexRecallEvent {
  framework: "codex";
  type: "recall";
  sessionId: string;
  agentId: string;
  userId: string;
  query?: string;
  scope?: CandidateScope;
  projectId?: string;
  topK?: number;
}

export interface CodexForgetEvent {
  framework: "codex";
  type: "forget";
  memcellId: string;
  agentId: string;
}

export interface CodexPrepareContextEvent {
  framework: "codex";
  type: "prepare_context";
  task: string;
  sessionId: string;
  agentId: string;
  userId: string;
  projectId?: string;
  tokenBudget?: number;
  topK?: number;
}

export interface CodexRecordHandoffEvent {
  framework: "codex";
  type: "record_handoff";
  task: string;
  summary: string;
  sessionId: string;
  agentId: string;
  userId: string;
  projectId?: string;
  decisions?: string[];
  constraints?: string[];
  failures?: string[];
  outcomes?: string[];
  unresolvedQuestions?: string[];
  evidenceRefs?: string[];
}

export type CodexEvent =
  | CodexSessionStartedEvent
  | CodexSessionEndedEvent
  | CodexRememberEvent
  | CodexRecallEvent
  | CodexForgetEvent
  | CodexPrepareContextEvent
  | CodexRecordHandoffEvent;

function isCodexEvent(event: unknown): event is CodexEvent {
  if (typeof event !== "object" || event === null) {
    return false;
  }

  const value = event as Record<string, unknown>;
  return (
    value.framework === "codex" &&
    (value.type === "session.started" ||
      value.type === "session.ended" ||
      value.type === "remember" ||
      value.type === "recall" ||
      value.type === "forget" ||
      value.type === "prepare_context" ||
      value.type === "record_handoff")
  );
}

export class CodexAdapter extends BaseFrameworkAdapter<CodexEvent> {
  constructor(db: Database, caller: ToolCaller) {
    super(db, createMcpToolClient(caller), "codex");
  }

  canHandle(event: unknown): event is CodexEvent {
    return isCodexEvent(event);
  }

  async remember(event: CodexRememberEvent): Promise<RememberResult | null> {
    const scope = event.scope ?? this.detectScope(event.projectId);
    const result = await this.protect("remember", async () =>
      this.bufferAndRemember({
        content: event.content,
        agentId: event.agentId,
        userId: event.userId,
        sessionId: event.sessionId,
        scope,
        ...(event.projectId !== undefined ? { projectId: event.projectId } : {}),
        ...(event.importanceHint !== undefined
          ? { importanceHint: event.importanceHint }
          : {}),
        sourceType: "adapter:codex:remember",
      })
    );

    return result?.remembered ?? null;
  }

  async recall(event: CodexRecallEvent): Promise<RecallResult> {
    const scope = event.scope ?? this.detectScope(event.projectId);
    const fallback: RecallResult = {
      results: [],
      scope_breakdown: { project: 0, agent: 0, global: 0 },
    };

    return (
      (await this.protect(
        "recall",
        () =>
          this.client.recall({
            user_id: event.userId,
            agent_id: event.agentId,
            ...(event.query !== undefined ? { query: event.query } : {}),
            ...(event.projectId !== undefined ? { project_id: event.projectId } : {}),
            ...(scope !== undefined ? { scope } : {}),
            ...(event.topK !== undefined ? { top_k: event.topK } : {}),
          }),
        fallback
      )) ?? fallback
    );
  }

  async forget(event: CodexForgetEvent): Promise<ForgetResult | null> {
    return this.protect(
      "forget",
      () =>
        this.client.forget({
          memcell_id: event.memcellId,
          agent_id: event.agentId,
        }),
      null
    );
  }

  async prepareContext(
    event: CodexPrepareContextEvent
  ): Promise<PrepareContextResult | null> {
    if (this.client.prepareContext === undefined) {
      return null;
    }
    return this.protect(
      "prepare_context",
      () =>
        this.client.prepareContext!({
          task: event.task,
          user_id: event.userId,
          agent_id: event.agentId,
          session_id: event.sessionId,
          ...(event.projectId !== undefined
            ? { project_id: event.projectId }
            : {}),
          ...(event.tokenBudget !== undefined
            ? { token_budget: event.tokenBudget }
            : {}),
          ...(event.topK !== undefined ? { top_k: event.topK } : {}),
        }),
      null
    );
  }

  async recordHandoff(
    event: CodexRecordHandoffEvent
  ): Promise<RecordHandoffResult | null> {
    if (this.client.recordHandoff === undefined) {
      return null;
    }
    const args: RecordHandoffArgs = {
      task: event.task,
      summary: event.summary,
      user_id: event.userId,
      agent_id: event.agentId,
      session_id: event.sessionId,
      framework: "codex",
      ...(event.projectId !== undefined
        ? { project_id: event.projectId }
        : {}),
      ...(event.decisions !== undefined
        ? { decisions: event.decisions }
        : {}),
      ...(event.constraints !== undefined
        ? { constraints: event.constraints }
        : {}),
      ...(event.failures !== undefined ? { failures: event.failures } : {}),
      ...(event.outcomes !== undefined ? { outcomes: event.outcomes } : {}),
      ...(event.unresolvedQuestions !== undefined
        ? { unresolved_questions: event.unresolvedQuestions }
        : {}),
      ...(event.evidenceRefs !== undefined
        ? { evidence_refs: event.evidenceRefs }
        : {}),
    };
    return this.protect(
      "record_handoff",
      () => this.client.recordHandoff!(args),
      null
    );
  }

  protected async handleEvent(event: CodexEvent): Promise<unknown> {
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

    if (event.type === "remember") {
      const remembered = await this.remember(event);
      return remembered === null
        ? null
        : {
            status: "captured",
            memcell_id: remembered.memcell_id,
          };
    }

    if (event.type === "recall") {
      return this.recall(event);
    }

    if (event.type === "prepare_context") {
      return this.prepareContext(event);
    }

    if (event.type === "record_handoff") {
      return this.recordHandoff(event);
    }

    return this.forget(event);
  }
}
