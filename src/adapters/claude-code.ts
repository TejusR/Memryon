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

export type ClaudeCodeEvent =
  | ClaudeCodeSessionStartedEvent
  | ClaudeCodeSessionEndedEvent
  | ClaudeCodePostToolUseEvent;

export interface ClaudeCodeAdapterOptions {
  claudeMdPath?: string;
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
      value.type === "PostToolUse")
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

    const session = this.requireSession(event.sessionId);
    const scope = this.detectScope(session.projectId);
    const content = this.buildToolMemoryContent(
      event.toolName,
      event.input,
      event.output,
      "Claude Code tool"
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
      sourceType: "adapter:claude-code:post-tool-use",
    });

    return {
      status: "captured",
      memcell_id: result.remembered.memcell_id,
      scope,
      ...(session.projectId !== undefined ? { project_id: session.projectId } : {}),
      candidates_buffered: result.candidatesBuffered,
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

    return sections.join("\n\n").trim();
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
