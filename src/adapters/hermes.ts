import type { Database } from "../db/connection.js";
import type { ForgetResult } from "../mcp/tools/forget.js";
import type { RecallResult } from "../mcp/tools/recall.js";
import type { RememberResult } from "../mcp/tools/remember.js";
import {
  BaseFrameworkAdapter,
  createHandlerBackedMemoryClient,
  type AdapterSessionEndedEvent,
  type AdapterSessionStartedEvent,
  type CandidateScope,
  type MemoryToolClient,
} from "./base.js";

export interface HermesSessionStartedEvent extends AdapterSessionStartedEvent {
  framework: "hermes";
}

export interface HermesSessionEndedEvent extends AdapterSessionEndedEvent {
  framework: "hermes";
}

export type HermesEvent = HermesSessionStartedEvent | HermesSessionEndedEvent;

export interface HermesAdapterOptions {
  defaultAgentId: string;
  defaultUserId: string;
}

export interface HermesMemoryInput {
  content: string;
  session_id?: string;
  agent_id?: string;
  user_id?: string;
  scope?: CandidateScope;
  project_id?: string;
  importance_hint?: number;
}

export interface HermesRetrieveQuery {
  query?: string;
  session_id?: string;
  agent_id?: string;
  user_id?: string;
  scope?: CandidateScope;
  project_id?: string;
  top_k?: number;
}

export interface HermesMemoryBackend {
  store(memory: HermesMemoryInput): Promise<RememberResult | null>;
  retrieve(query: HermesRetrieveQuery): Promise<RecallResult>;
  delete(id: string): Promise<ForgetResult | null>;
}

export interface HermesMemoryProviderPlugin {
  name: string;
  version: string;
  backend: HermesMemoryBackend;
}

function isHermesEvent(event: unknown): event is HermesEvent {
  if (typeof event !== "object" || event === null) {
    return false;
  }

  const value = event as Record<string, unknown>;
  return (
    value.framework === "hermes" &&
    (value.type === "session.started" || value.type === "session.ended")
  );
}

export class HermesAdapter
  extends BaseFrameworkAdapter<HermesEvent>
  implements HermesMemoryBackend
{
  constructor(
    db: Database,
    private readonly options: HermesAdapterOptions,
    client: MemoryToolClient = createHandlerBackedMemoryClient(db)
  ) {
    super(db, client, "hermes");
  }

  canHandle(event: unknown): event is HermesEvent {
    return isHermesEvent(event);
  }

  protected async handleEvent(event: HermesEvent): Promise<unknown> {
    if (event.type === "session.started") {
      const session = this.createSession(event);
      return {
        status: "session_started",
        session_id: session.sessionId,
        scope: session.scope,
      };
    }

    this.endSession(event.sessionId);
    return {
      status: "session_ended",
      session_id: event.sessionId,
    };
  }

  async store(memory: HermesMemoryInput): Promise<RememberResult | null> {
    const session = this.getSession(memory.session_id);
    const agentId =
      memory.agent_id ?? session?.agentId ?? this.options.defaultAgentId;
    const userId = memory.user_id ?? session?.userId ?? this.options.defaultUserId;
    const projectId = memory.project_id ?? session?.projectId;
    const scope = memory.scope ?? this.detectScope(projectId);
    const sessionId = memory.session_id ?? session?.sessionId ?? "hermes-session";

    const result = await this.protect("store", async () =>
      this.bufferAndRemember({
        content: memory.content,
        agentId,
        userId,
        sessionId,
        scope,
        ...(projectId !== undefined ? { projectId } : {}),
        ...(memory.importance_hint !== undefined
          ? { importanceHint: memory.importance_hint }
          : {}),
        sourceType: "adapter:hermes:store",
      })
    );

    return result?.remembered ?? null;
  }

  async retrieve(query: HermesRetrieveQuery): Promise<RecallResult> {
    const session = this.getSession(query.session_id);
    const agentId =
      query.agent_id ?? session?.agentId ?? this.options.defaultAgentId;
    const userId = query.user_id ?? session?.userId ?? this.options.defaultUserId;
    const projectId = query.project_id ?? session?.projectId;
    const scope = query.scope ?? this.detectScope(projectId);
    const fallback: RecallResult = {
      results: [],
      scope_breakdown: { project: 0, agent: 0, global: 0 },
    };

    return (
      (await this.protect(
        "retrieve",
        () =>
          this.client.recall({
            agent_id: agentId,
            user_id: userId,
            ...(query.query !== undefined ? { query: query.query } : {}),
            ...(projectId !== undefined ? { project_id: projectId } : {}),
            ...(scope !== undefined ? { scope } : {}),
            ...(query.top_k !== undefined ? { top_k: query.top_k } : {}),
          }),
        fallback
      )) ?? fallback
    );
  }

  async delete(id: string): Promise<ForgetResult | null> {
    return this.protect(
      "delete",
      () =>
        this.client.forget({
          memcell_id: id,
          agent_id: this.options.defaultAgentId,
        }),
      null
    );
  }
}

export function createHermesMemoryProvider(
  adapter: HermesAdapter
): HermesMemoryProviderPlugin {
  return {
    name: "memryon-hermes",
    version: "0.1.0",
    backend: {
      store: (memory) => adapter.store(memory),
      retrieve: (query) => adapter.retrieve(query),
      delete: (id) => adapter.delete(id),
    },
  };
}
