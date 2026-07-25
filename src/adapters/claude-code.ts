import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "../db/connection.js";
import {
  BaseFrameworkAdapter,
  createHandlerBackedMemoryClient,
  type AdapterSessionEndedEvent,
  type AdapterSessionStartedEvent,
  type MemoryToolClient,
} from "./base.js";

export interface ClaudeCodeSessionStartedEvent
  extends AdapterSessionStartedEvent {
  framework: "claude-code";
  claudeMdPath?: string;
  task?: string;
}

export interface ClaudeCodeSessionEndedEvent extends AdapterSessionEndedEvent {
  framework: "claude-code";
}

export interface ClaudeCodePostToolUseEvent {
  framework: "claude-code";
  type: "PostToolUse";
  sessionId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  importanceHint?: number;
}

export interface ClaudeCodeUserPromptSubmitEvent {
  framework: "claude-code";
  type: "UserPromptSubmit";
  sessionId: string;
  agentId: string;
  userId: string;
  projectId?: string;
  prompt: string;
}

export interface ClaudeCodeStopEvent {
  framework: "claude-code";
  type: "Stop";
  sessionId: string;
}

export type ClaudeCodeEvent =
  | ClaudeCodeSessionStartedEvent
  | ClaudeCodeSessionEndedEvent
  | ClaudeCodePostToolUseEvent
  | ClaudeCodeUserPromptSubmitEvent
  | ClaudeCodeStopEvent;

export interface ClaudeCodeAdapterOptions {
  claudeMdPath?: string;
  captureToolActivity?: boolean;
}

function isClaudeCodeEvent(event: unknown): event is ClaudeCodeEvent {
  if (typeof event !== "object" || event === null) {
    return false;
  }

  const value = event as Record<string, unknown>;
  return (
    value.framework === "claude-code" &&
    (value.type === "session.started" ||
      value.type === "session.ended" ||
      value.type === "PostToolUse" ||
      value.type === "UserPromptSubmit" ||
      value.type === "Stop")
  );
}

export class ClaudeCodeAdapter extends BaseFrameworkAdapter<ClaudeCodeEvent> {
  constructor(
    db: Database,
    private readonly options: ClaudeCodeAdapterOptions = {},
    client: MemoryToolClient = createHandlerBackedMemoryClient(db)
  ) {
    super(db, client, "claude-code");
  }

  canHandle(event: unknown): event is ClaudeCodeEvent {
    return isClaudeCodeEvent(event);
  }

  protected async handleEvent(event: ClaudeCodeEvent): Promise<unknown> {
    if (event.type === "session.started") {
      const injectedContext = await this.buildInjectedContext(event);
      const session = this.createSession(event, injectedContext);
      if (event.task !== undefined) {
        session.currentTask = event.task;
      }

      return {
        status: "session_started",
        session_id: session.sessionId,
        scope: session.scope,
        injected_context: injectedContext,
      };
    }

    if (event.type === "session.ended") {
      this.endSession(event.sessionId);
      return {
        status: "session_ended",
        session_id: event.sessionId,
      };
    }

    if (event.type === "UserPromptSubmit") {
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
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: context,
        },
      };
    }

    if (event.type === "Stop") {
      const session = this.requireSession(event.sessionId);
      if (
        session.substantiveActivity !== true ||
        session.stopReminderIssued === true ||
        this.hasRecordedHandoff(session.sessionId, session.agentId)
      ) {
        return { status: "continue" };
      }
      session.stopReminderIssued = true;
      return {
        decision: "block",
        reason: [
          "Before finishing, call memryon.record_handoff once with the decisions, constraints, failures, outcomes, and unresolved questions from this task.",
          `Use user_id=${JSON.stringify(
            session.userId
          )}, agent_id=${JSON.stringify(
            session.agentId
          )}, framework="claude-code", session_id=${JSON.stringify(
            session.sessionId
          )}`,
          ...(session.projectId !== undefined
            ? [`and project_id=${JSON.stringify(session.projectId)}.`]
            : ["."]),
          "Do not include hidden reasoning.",
        ].join(" "),
      };
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
      "Claude Code tool"
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
      sourceType: "adapter:claude-code:post-tool-use",
    };

    return {
      status: "buffered",
      scope,
      ...(session.projectId !== undefined ? { project_id: session.projectId } : {}),
      candidates_buffered: this.bufferCandidateActivity(captureInput),
    };
  }

  private async buildInjectedContext(
    event: ClaudeCodeSessionStartedEvent
  ): Promise<string> {
    const claudeMdPath =
      event.claudeMdPath ??
      this.options.claudeMdPath ??
      path.resolve(process.cwd(), "CLAUDE.md");
    const claudeMd = await this.readClaudeMd(claudeMdPath);
    const sections: string[] = [];

    if (claudeMd.length > 0) {
      sections.push("# CLAUDE.md");
      sections.push(claudeMd);
    }

    if (event.projectId && this.client.projectContext !== undefined) {
      const context = await this.client.projectContext({
        project_id: event.projectId,
        user_id: event.userId,
      });

      sections.push("# Project Context");
      sections.push(`Project: ${context.project.name}`);
      sections.push(`Memory count: ${context.memory_count}`);

      if (context.recent_activity.length > 0) {
        sections.push(
          context.recent_activity
            .map(
              (entry) =>
                `- ${entry.agent_id} @ ${entry.recorded_at}: ${entry.content}`
            )
            .join("\n")
        );
      }
    }

    const task = event.task ?? "Resume substantive work in this project";
    const compiled = await this.prepareForTask(
      task,
      event.userId,
      event.agentId,
      event.sessionId,
      event.projectId
    );
    if (compiled.length > 0) {
      sections.push(compiled);
    }

    return sections.join("\n\n").trim();
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

  private async readClaudeMd(filePath: string): Promise<string> {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }
}
