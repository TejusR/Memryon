import { spawnSync } from "node:child_process";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

function runMemryon(args) {
  const result = spawnSync("memryon", args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 3_000,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr || "unknown error";
    throw new Error(detail.trim());
  }
  return JSON.parse(result.stdout);
}

function commonArgs(ctx, config) {
  const args = [
    "--user",
    config?.userId || "local-user",
    "--agent",
    "openclaw",
  ];
  const sessionId = ctx.sessionId || ctx.sessionKey;
  if (sessionId) args.push("--session", String(sessionId));
  if (config?.projectId) args.push("--project", String(config.projectId));
  return args;
}

export default definePluginEntry({
  id: "memryon",
  name: "Memryon",
  description: "Shared project context for OpenClaw and other agents.",
  register(api) {
    const pluginConfig = api.pluginConfig || {};
    const remindedSessions = new Set();
    const substantiveSessions = new Set();
    const sessionProjects = new Map();
    const sessionUsers = new Map();

    api.on(
      "agent_turn_prepare",
      async (event, ctx) => {
        const sessionId = String(ctx.sessionId || ctx.sessionKey || "");
        if (sessionId && String(event.prompt || "").trim().length >= 20) {
          substantiveSessions.add(sessionId);
          if (pluginConfig.projectId) {
            sessionProjects.set(sessionId, String(pluginConfig.projectId));
          }
          sessionUsers.set(
            sessionId,
            String(pluginConfig.userId || "local-user")
          );
        }
        try {
          const result = runMemryon([
            "context",
            String(event.prompt || ""),
            "--json",
            ...commonArgs(ctx, pluginConfig),
          ]);
          return { prependContext: result.context };
        } catch (error) {
          return {
            prependContext:
              `[Memryon warning: relevant context could not be loaded: ${error.message}. Continuing without it.]`,
          };
        }
      },
      { priority: 50, timeoutMs: 3_000 }
    );

    api.on(
      "before_agent_finalize",
      async (event, ctx) => {
        const sessionId = String(
          ctx.sessionId ||
            ctx.sessionKey ||
            event.sessionId ||
            event.sessionKey ||
            ""
        );
        const substantive =
          substantiveSessions.has(sessionId) ||
          String(event.lastAssistantMessage || "").trim().length >= 200 ||
          (Array.isArray(event.messages) && event.messages.length >= 4);
        if (
          !sessionId ||
          !substantive ||
          remindedSessions.has(sessionId)
        ) {
          return;
        }
        try {
          const status = runMemryon([
            "hook",
            "handoff-status",
            "--session",
            sessionId,
            "--agent",
            "openclaw",
            "--json",
          ]);
          if (status.recorded) return;
        } catch {
          return;
        }
        remindedSessions.add(sessionId);
        return {
          action: "revise",
          reason: "This substantive task needs a Memryon handoff.",
          retry: {
            instruction:
              "Call record_handoff once with concise decisions, constraints, failures, outcomes, and unresolved questions, then finish. Do not include hidden reasoning.",
            idempotencyKey: `memryon-handoff-${sessionId}`,
            maxAttempts: 1,
          },
        };
      },
      { priority: 50, timeoutMs: 3_000 }
    );

    api.registerTool((toolContext) => ({
      name: "record_handoff",
      description:
        "Record durable decisions, constraints, failures, outcomes, and unresolved questions for the next agent.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["task"],
        properties: {
          task: { type: "string" },
          summary: { type: "string" },
          session_id: { type: "string" },
          project_id: { type: "string" },
          decisions: { type: "array", items: { type: "string" } },
          constraints: { type: "array", items: { type: "string" } },
          failures: { type: "array", items: { type: "string" } },
          outcomes: { type: "array", items: { type: "string" } },
          unresolved_questions: {
            type: "array",
            items: { type: "string" },
          },
          evidence_refs: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
      async execute(_id, params) {
        const sessionId = String(
          params.session_id ||
            toolContext.sessionId ||
            toolContext.sessionKey ||
            ""
        );
        const projectId =
          params.project_id || sessionProjects.get(sessionId);
        const args = [
          "handoff",
          "--json-input",
          JSON.stringify({
            ...params,
            summary: params.summary || "",
            user_id: sessionUsers.get(sessionId) || "local-user",
            agent_id: "openclaw",
            framework: "openclaw",
            ...(sessionId ? { session_id: sessionId } : {}),
            ...(projectId ? { project_id: projectId } : {}),
          }),
          "--json",
        ];
        const result = runMemryon(args);
        if (sessionId) remindedSessions.add(sessionId);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
    }));
  },
});
