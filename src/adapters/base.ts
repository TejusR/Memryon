import type { Database } from "../db/connection.js";
import {
  logAdapterError,
  type AdapterErrorRow,
} from "../db/queries/adapter-errors.js";
import {
  extractCandidates,
  type CandidateScope,
} from "../ingestion/fast-path.js";
import {
  handleForget,
  type ForgetArgs,
  type ForgetResult,
} from "../mcp/tools/forget.js";
import {
  handleProjectContext,
  type ProjectContextArgs,
  type ProjectContextResult,
} from "../mcp/tools/project-context.js";
import {
  handleRecall,
  type RecallArgs,
  type RecallResult,
} from "../mcp/tools/recall.js";
import {
  handleRemember,
  type RememberArgs,
  type RememberResult,
} from "../mcp/tools/remember.js";
import { MemryonError, errorMessage } from "../utils/errors.js";

export type { CandidateScope };

export interface FrameworkAdapter {
  initialize(): Promise<void>;
  canHandle(event: unknown): boolean;
  onEvent(event: unknown): Promise<unknown>;
  shutdown(): Promise<void>;
}

export interface AdapterSessionState {
  sessionId: string;
  agentId: string;
  userId: string;
  projectId?: string;
  scope: CandidateScope;
  injectedContext?: string;
}

export interface AdapterSessionStartedEvent {
  type: "session.started";
  sessionId: string;
  agentId: string;
  userId: string;
  projectId?: string;
}

export interface AdapterSessionEndedEvent {
  type: "session.ended";
  sessionId: string;
}

export interface MemoryToolClient {
  remember(args: RememberArgs): Promise<RememberResult>;
  recall(args: RecallArgs): Promise<RecallResult>;
  forget(args: ForgetArgs): Promise<ForgetResult>;
  projectContext?(args: ProjectContextArgs): Promise<ProjectContextResult>;
}

export interface BufferAndRememberInput {
  content: string;
  agentId: string;
  userId: string;
  sessionId: string;
  scope: CandidateScope;
  projectId?: string;
  importanceHint?: number;
  sourceType?: string;
}

export interface BufferAndRememberResult {
  remembered: RememberResult;
  candidatesBuffered: number;
}

export interface ToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallContentBlock {
  type: string;
  text?: string;
}

export interface ToolCallResponse {
  content: ToolCallContentBlock[];
  isError?: boolean;
}

export interface ToolCaller {
  callTool(request: ToolCallRequest): Promise<ToolCallResponse>;
}

/**
 * Builds a memory client that calls the local handler functions directly.
 */
export function createHandlerBackedMemoryClient(db: Database): MemoryToolClient {
  return {
    async remember(args) {
      return handleRemember(db, args);
    },
    async recall(args) {
      return handleRecall(db, args);
    },
    async forget(args) {
      return handleForget(db, args);
    },
    async projectContext(args) {
      return handleProjectContext(db, args);
    },
  };
}

function parseToolResult<T>(response: ToolCallResponse): T {
  const textBlock = response.content.find(
    (block) => block.type === "text" && typeof block.text === "string"
  );

  if (textBlock?.text === undefined) {
    throw new MemryonError(
      "MCP tool response did not contain a text payload"
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(textBlock.text) as Record<string, unknown>;
  } catch (error) {
    throw new MemryonError(
      `MCP tool response was not valid JSON: ${errorMessage(error)}`
    );
  }

  if (response.isError) {
    throw new MemryonError(String(parsed.error ?? "MCP tool call failed"));
  }

  return parsed as T;
}

/**
 * Builds a memory client that talks to Memryon through an MCP tool caller.
 */
export function createMcpToolClient(caller: ToolCaller): MemoryToolClient {
  return {
    async remember(args) {
      return parseToolResult<RememberResult>(
        await caller.callTool({
          name: "remember",
          arguments: args as unknown as Record<string, unknown>,
        })
      );
    },
    async recall(args) {
      return parseToolResult<RecallResult>(
        await caller.callTool({
          name: "recall",
          arguments: args as unknown as Record<string, unknown>,
        })
      );
    },
    async forget(args) {
      return parseToolResult<ForgetResult>(
        await caller.callTool({
          name: "forget",
          arguments: args as unknown as Record<string, unknown>,
        })
      );
    },
    async projectContext(args) {
      return parseToolResult<ProjectContextResult>(
        await caller.callTool({
          name: "project_context",
          arguments: args as unknown as Record<string, unknown>,
        })
      );
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export abstract class BaseFrameworkAdapter<TEvent>
  implements FrameworkAdapter
{
  protected readonly sessions = new Map<string, AdapterSessionState>();

  protected constructor(
    protected readonly db: Database,
    protected readonly client: MemoryToolClient,
    protected readonly framework: string
  ) {}

  async initialize(): Promise<void> {}

  abstract canHandle(event: unknown): event is TEvent;

  async onEvent(event: unknown): Promise<unknown> {
    if (!this.canHandle(event)) {
      return null;
    }

    return this.protect(`event:${this.getEventLabel(event)}`, () =>
      this.handleEvent(event)
    );
  }

  async shutdown(): Promise<void> {
    this.sessions.clear();
  }

  protected abstract handleEvent(event: TEvent): Promise<unknown>;

  protected async protect<T>(
    operation: string,
    work: () => Promise<T> | T,
    fallback: T | null = null
  ): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      this.recordError(operation, error);
      return fallback;
    }
  }

  protected createSession(
    event: AdapterSessionStartedEvent,
    injectedContext?: string
  ): AdapterSessionState {
    const session: AdapterSessionState = {
      sessionId: event.sessionId,
      agentId: event.agentId,
      userId: event.userId,
      scope: this.detectScope(event.projectId),
      ...(event.projectId !== undefined ? { projectId: event.projectId } : {}),
      ...(injectedContext !== undefined ? { injectedContext } : {}),
    };

    this.sessions.set(event.sessionId, session);
    return session;
  }

  protected endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  protected requireSession(sessionId: string): AdapterSessionState {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new MemryonError(
        `No active ${this.framework} session found for '${sessionId}'`
      );
    }

    return session;
  }

  protected getSession(sessionId?: string): AdapterSessionState | undefined {
    if (sessionId === undefined) {
      return undefined;
    }

    return this.sessions.get(sessionId);
  }

  protected detectScope(projectId?: string): CandidateScope {
    return projectId ? "project" : "agent";
  }

  protected async bufferAndRemember(
    input: BufferAndRememberInput
  ): Promise<BufferAndRememberResult> {
    const projectId = input.scope === "project" ? input.projectId : undefined;

    const buffered = extractCandidates(
      this.db,
      input.content,
      input.agentId,
      this.framework,
      input.sessionId,
      input.scope,
      projectId
    );

    const remembered = await this.client.remember({
      content: input.content,
      agent_id: input.agentId,
      user_id: input.userId,
      scope: input.scope,
      framework: this.framework,
      session_id: input.sessionId,
      ...(projectId !== undefined ? { project_id: projectId } : {}),
      ...(input.importanceHint !== undefined
        ? { importance_hint: input.importanceHint }
        : {}),
      ...(input.sourceType !== undefined
        ? { source_type: input.sourceType }
        : {}),
    });

    return {
      remembered,
      candidatesBuffered: buffered.candidates_buffered,
    };
  }

  protected buildToolMemoryContent(
    toolName: string,
    input: unknown,
    output: unknown,
    prefix: string
  ): string {
    return [
      `${prefix} '${toolName}' completed.`,
      `Input: ${this.serialize(input)}`,
      `Output: ${this.serialize(output)}`,
    ].join("\n");
  }

  protected serialize(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  protected recordError(
    operation: string,
    error: unknown
  ): AdapterErrorRow {
    const message = errorMessage(error);
    return logAdapterError(this.db, {
      adapter: this.framework,
      error: `${operation}: ${message}`,
    });
  }

  private getEventLabel(event: TEvent): string {
    if (isRecord(event) && typeof event.type === "string") {
      return event.type;
    }

    return "unknown";
  }
}
