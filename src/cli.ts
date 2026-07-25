#!/usr/bin/env node

import { spawn } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeDb, getDb, type Database } from "./db/connection.js";
import { getSchemaVersion } from "./db/migrations.js";
import {
  findProjectRoot,
  initializeProject,
  readProjectConfig,
  type IntegrationName,
} from "./config/project.js";
import {
  DEFAULT_USER_ID,
  getDefaultDbPath,
  getMemryonDataDir,
} from "./config/paths.js";
import { installIntegration } from "./integrations/install.js";
import {
  getModelStatus,
  installModels,
  type ModelInstallProgress,
} from "./models/cache.js";
import { handlePrepareContext } from "./mcp/tools/prepare-context.js";
import {
  handleRecordHandoff,
  type RecordHandoffArgs,
} from "./mcp/tools/record-handoff.js";
import { handleConflicts } from "./mcp/tools/conflicts.js";
import { handleForget } from "./mcp/tools/forget.js";
import { serveMcpServer } from "./mcp/server.js";
import { errorMessage, ValidationError } from "./utils/errors.js";

const BOOLEAN_OPTIONS = new Set([
  "json",
  "skip-models",
  "bm25-only",
  "help",
]);

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string[]>;
}

interface CommandContext {
  userId: string;
  agentId: string;
  projectId?: string;
  sessionId?: string;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const name =
      equals >= 0 ? token.slice(2, equals) : token.slice(2);
    let value = equals >= 0 ? token.slice(equals + 1) : "true";
    if (
      equals < 0 &&
      !BOOLEAN_OPTIONS.has(name) &&
      args[index + 1] !== undefined &&
      !args[index + 1]!.startsWith("--")
    ) {
      value = args[index + 1]!;
      index += 1;
    }
    const values = options.get(name) ?? [];
    values.push(value);
    options.set(name, values);
  }
  return { positionals, options };
}

function option(args: ParsedArgs, name: string): string | undefined {
  return args.options.get(name)?.at(-1);
}

function optionValues(args: ParsedArgs, name: string): string[] | undefined {
  const values = args.options.get(name);
  return values === undefined || values.length === 0 ? undefined : values;
}

function flag(args: ParsedArgs, name: string): boolean {
  return args.options.has(name);
}

function print(value: unknown, asJson: boolean): void {
  if (asJson || typeof value !== "string") {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    process.stdout.write(`${value}\n`);
  }
}

async function commandContext(args: ParsedArgs): Promise<CommandContext> {
  const root = await findProjectRoot(process.cwd());
  const config =
    root === undefined ? undefined : await readProjectConfig(root);
  const projectId = option(args, "project") ?? config?.project_id;
  const sessionId = option(args, "session");
  return {
    userId: option(args, "user") ?? config?.user_id ?? DEFAULT_USER_ID,
    agentId:
      option(args, "agent") ??
      process.env["MEMRYON_AGENT_ID"] ??
      "codex",
    ...(projectId !== undefined ? { projectId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

function openDefaultDb(): Database {
  return getDb(getDefaultDbPath());
}

function modelProgressReporter(): (progress: ModelInstallProgress) => void {
  const lastPercent = new Map<string, number>();
  return (progress) => {
    if (progress.status === "progress" && progress.progress !== undefined) {
      const key = `${progress.component}:${progress.file ?? "model"}`;
      const percent = Math.floor(progress.progress);
      const previous = lastPercent.get(key) ?? -10;
      if (percent < 100 && percent - previous < 10) {
        return;
      }
      lastPercent.set(key, percent);
      process.stderr.write(
        `[${progress.component}] ${progress.file ?? "model"} ${percent}%\n`
      );
      return;
    }
    if (progress.status === "done") {
      process.stderr.write(
        `[${progress.component}] ${progress.file ?? "model"} ready\n`
      );
    }
  };
}

async function runInit(args: ParsedArgs): Promise<void> {
  const db = openDefaultDb();
  const project = await initializeProject(
    db,
    process.cwd(),
    option(args, "user") ?? DEFAULT_USER_ID
  );
  let models: unknown = { skipped: true };
  if (!flag(args, "skip-models")) {
    process.stderr.write("Installing pinned local embedding model...\n");
    models = await installModels({ onProgress: modelProgressReporter() });
    process.stderr.write("Model download and checksum verification complete.\n");
  }
  print(
    {
      status: "initialized",
      data_dir: getMemryonDataDir(),
      database: getDefaultDbPath(),
      project,
      models,
    },
    flag(args, "json")
  );
}

async function runDoctor(args: ParsedArgs): Promise<void> {
  const db = openDefaultDb();
  const vectorVersion = db
    .prepare<[], { version: string }>(`SELECT vec_version() AS version`)
    .get()?.version;
  const projectRoot = await findProjectRoot(process.cwd());
  const project =
    projectRoot === undefined
      ? undefined
      : await readProjectConfig(projectRoot);
  const models = await getModelStatus();
  const result = {
    healthy:
      getSchemaVersion(db) >= 6 &&
      vectorVersion !== undefined &&
      project !== undefined,
    schema_version: getSchemaVersion(db),
    sqlite_vec_version: vectorVersion ?? null,
    database: getDefaultDbPath(),
    project: project ?? null,
    models,
  };
  print(result, flag(args, "json"));
}

async function runModels(args: ParsedArgs): Promise<void> {
  const subcommand = args.positionals[0] ?? "status";
  if (subcommand === "install") {
    process.stderr.write("Downloading pinned model snapshots...\n");
    const manifest = await installModels({
      onProgress: modelProgressReporter(),
    });
    print(manifest, flag(args, "json"));
    return;
  }
  if (subcommand === "status") {
    print(await getModelStatus(), flag(args, "json"));
    return;
  }
  throw new ValidationError(`Unknown models command '${subcommand}'`);
}

async function runIntegrate(args: ParsedArgs): Promise<void> {
  const integration = args.positionals[0] as IntegrationName | undefined;
  if (
    integration === undefined ||
    !["claude-code", "codex", "openclaw", "hermes"].includes(integration)
  ) {
    throw new ValidationError(
      "integrate requires claude-code, codex, openclaw, or hermes"
    );
  }
  const result = await installIntegration(
    openDefaultDb(),
    integration,
    process.cwd()
  );
  print(result, flag(args, "json"));
}

async function runContext(args: ParsedArgs): Promise<void> {
  const task =
    option(args, "task") ?? args.positionals.join(" ").trim();
  if (task.length === 0) {
    throw new ValidationError("context requires a task");
  }
  const context = await commandContext(args);
  const tokenBudget = option(args, "token-budget");
  const topK = option(args, "top-k");
  const result = await handlePrepareContext(
    openDefaultDb(),
    {
      task,
      user_id: context.userId,
      agent_id: context.agentId,
      ...(context.projectId !== undefined
        ? { project_id: context.projectId }
        : {}),
      ...(context.sessionId !== undefined
        ? { session_id: context.sessionId }
        : {}),
      ...(tokenBudget !== undefined
        ? { token_budget: Number(tokenBudget) }
        : {}),
      ...(topK !== undefined ? { top_k: Number(topK) } : {}),
    },
    flag(args, "bm25-only")
      ? { embeddingProvider: null, reranker: null }
      : {}
  );
  print(flag(args, "json") ? result : result.context, flag(args, "json"));
}

function parseHandoffPayload(value: string): RecordHandoffArgs {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("--json-input must contain a JSON object");
  }
  return parsed as RecordHandoffArgs;
}

async function runHandoff(args: ParsedArgs): Promise<void> {
  const jsonInput = option(args, "json-input");
  let payload: RecordHandoffArgs;
  if (jsonInput !== undefined) {
    payload = parseHandoffPayload(jsonInput);
  } else {
    const context = await commandContext(args);
    payload = {
      task: option(args, "task") ?? args.positionals.join(" "),
      summary: option(args, "summary") ?? "",
      user_id: context.userId,
      agent_id: context.agentId,
      ...(context.projectId !== undefined
        ? { project_id: context.projectId }
        : {}),
      ...(context.sessionId !== undefined
        ? { session_id: context.sessionId }
        : {}),
      ...(option(args, "framework") !== undefined
        ? { framework: option(args, "framework")! }
        : {}),
      ...(optionValues(args, "decision") !== undefined
        ? { decisions: optionValues(args, "decision")! }
        : {}),
      ...(optionValues(args, "constraint") !== undefined
        ? { constraints: optionValues(args, "constraint")! }
        : {}),
      ...(optionValues(args, "failure") !== undefined
        ? { failures: optionValues(args, "failure")! }
        : {}),
      ...(optionValues(args, "outcome") !== undefined
        ? { outcomes: optionValues(args, "outcome")! }
        : {}),
      ...(optionValues(args, "question") !== undefined
        ? { unresolved_questions: optionValues(args, "question")! }
        : {}),
      ...(optionValues(args, "evidence") !== undefined
        ? { evidence_refs: optionValues(args, "evidence")! }
        : {}),
    };
  }

  const context = await commandContext(args);
  payload = {
    ...payload,
    user_id: payload.user_id || context.userId,
    agent_id: payload.agent_id || context.agentId,
    ...(payload.project_id === undefined && context.projectId !== undefined
      ? { project_id: context.projectId }
      : {}),
    ...(payload.session_id === undefined && context.sessionId !== undefined
      ? { session_id: context.sessionId }
      : {}),
  };
  print(
    handleRecordHandoff(openDefaultDb(), payload),
    flag(args, "json")
  );
}

function portableValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return { encoding: "base64", data: value.toString("base64") };
  }
  if (Array.isArray(value)) {
    return value.map(portableValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        portableValue(entry),
      ])
    );
  }
  return value;
}

function tableRows(db: Database, table: string): unknown[] {
  const allowed = new Set([
    "agents",
    "projects",
    "project_agents",
    "memories",
    "handoffs",
    "handoff_memories",
    "corroborations",
    "conflicts",
    "store_items",
  ]);
  if (!allowed.has(table)) {
    throw new ValidationError(`Unsupported export table '${table}'`);
  }
  return db.prepare(`SELECT * FROM ${table}`).all();
}

async function runExport(args: ParsedArgs): Promise<void> {
  const db = openDefaultDb();
  const tables = [
    "agents",
    "projects",
    "project_agents",
    "memories",
    "handoffs",
    "handoff_memories",
    "corroborations",
    "conflicts",
    "store_items",
  ];
  const backup = {
    format: "memryon-export",
    version: 1,
    exported_at: new Date().toISOString(),
    schema_version: getSchemaVersion(db),
    tables: Object.fromEntries(
      tables.map((table) => [table, portableValue(tableRows(db, table))])
    ),
  };
  const serialized = `${JSON.stringify(backup, null, 2)}\n`;
  const output = option(args, "output");
  if (output !== undefined) {
    const target = path.resolve(output);
    await writeFile(target, serialized, "utf8");
    print({ status: "exported", path: target }, flag(args, "json"));
  } else {
    process.stdout.write(serialized);
  }
}

async function runMemories(args: ParsedArgs): Promise<void> {
  if ((args.positionals[0] ?? "list") !== "list") {
    throw new ValidationError("memories currently supports only 'list'");
  }
  const context = await commandContext(args);
  const limit = Number(option(args, "limit") ?? 50);
  const rows = openDefaultDb()
    .prepare<unknown[], Record<string, unknown>>(
      `SELECT id, scope, project_id, agent_id, content, memory_kind, task_id,
              framework, recorded_at, valid_until, invalidated_at,
              evidence_refs_json, metadata_json
       FROM memories
       WHERE user_id = ?
       ORDER BY recorded_at DESC
       LIMIT ?`
    )
    .all(context.userId, limit);
  print(rows, true);
}

async function runConflicts(args: ParsedArgs): Promise<void> {
  const context = await commandContext(args);
  print(
    handleConflicts(openDefaultDb(), {
      ...(context.projectId !== undefined
        ? { project_id: context.projectId }
        : {}),
      ...(option(args, "since") !== undefined
        ? { since: option(args, "since")! }
        : {}),
    }),
    true
  );
}

async function runForget(args: ParsedArgs): Promise<void> {
  const memoryId = option(args, "id") ?? args.positionals[0];
  if (memoryId === undefined || memoryId.trim().length === 0) {
    throw new ValidationError("forget requires a memory ID");
  }
  const context = await commandContext(args);
  print(
    handleForget(openDefaultDb(), {
      memcell_id: memoryId,
      agent_id: context.agentId,
      ...(option(args, "reason") !== undefined
        ? { reason: option(args, "reason")! }
        : {}),
    }),
    flag(args, "json")
  );
}

async function readStdinJson(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  if (chunks.length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

async function hookProjectContext(
  input: Record<string, unknown>
): Promise<CommandContext> {
  const cwd = typeof input["cwd"] === "string" ? input["cwd"] : process.cwd();
  const root = await findProjectRoot(cwd);
  const config = root === undefined ? undefined : await readProjectConfig(root);
  return {
    userId: config?.user_id ?? DEFAULT_USER_ID,
    agentId: "claude-code",
    ...(config?.project_id !== undefined
      ? { projectId: config.project_id }
      : {}),
    ...(typeof input["session_id"] === "string"
      ? { sessionId: input["session_id"] }
      : {}),
  };
}

async function runClaudeContextHook(): Promise<void> {
  const input = await readStdinJson();
  const context = await hookProjectContext(input);
  const eventName =
    typeof input["hook_event_name"] === "string"
      ? input["hook_event_name"]
      : "UserPromptSubmit";
  const task =
    typeof input["prompt"] === "string"
      ? input["prompt"]
      : "Resume substantive work in this project";
  try {
    const result = await handlePrepareContext(
      openDefaultDb(),
      {
        task,
        user_id: context.userId,
        agent_id: context.agentId,
        ...(context.projectId !== undefined
          ? { project_id: context.projectId }
          : {}),
        ...(context.sessionId !== undefined
          ? { session_id: context.sessionId }
          : {}),
      },
      { timeoutMs: 1_200 }
    );
    print(
      {
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext: result.context,
        },
      },
      true
    );
  } catch (error) {
    print(
      {
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext:
            `[Memryon warning: relevant context could not be loaded: ${errorMessage(
              error
            )}. Continuing without it.]`,
        },
      },
      true
    );
  }
}

function hasHandoff(
  db: Database,
  sessionId: string,
  agentId: string
): boolean {
  return (
    db
      .prepare<[string, string], { present: number }>(
        `SELECT 1 AS present
         FROM handoffs
         WHERE session_id = ? AND agent_id = ?
         LIMIT 1`
      )
      .get(sessionId, agentId) !== undefined
  );
}

async function runClaudeStopHook(): Promise<void> {
  const input = await readStdinJson();
  const context = await hookProjectContext(input);
  if (
    context.sessionId === undefined ||
    hasHandoff(openDefaultDb(), context.sessionId, context.agentId)
  ) {
    print({}, true);
    return;
  }

  let substantive = input["substantive"] === true;
  if (!substantive && typeof input["transcript_path"] === "string") {
    try {
      substantive = (await stat(input["transcript_path"])).size >= 2_048;
    } catch {
      substantive = false;
    }
  }
  if (!substantive) {
    print({}, true);
    return;
  }

  const inserted = openDefaultDb()
    .prepare(
      `INSERT OR IGNORE INTO hook_reminders (session_id, agent_id)
       VALUES (?, ?)`
    )
    .run(context.sessionId, context.agentId);
  if (inserted.changes === 0) {
    print({}, true);
    return;
  }
  print(
    {
      decision: "block",
      reason: [
        "Call memryon's record_handoff once with concise decisions, constraints, failures, outcomes, and unresolved questions, then finish.",
        `Use user_id=${JSON.stringify(
          context.userId
        )}, agent_id=${JSON.stringify(
          context.agentId
        )}, framework="claude-code", session_id=${JSON.stringify(
          context.sessionId
        )}`,
        ...(context.projectId !== undefined
          ? [`and project_id=${JSON.stringify(context.projectId)}.`]
          : ["."]),
        "Do not include hidden reasoning.",
      ].join(" "),
    },
    true
  );
}

async function runHook(args: ParsedArgs): Promise<void> {
  const hook = args.positionals[0];
  if (hook === "claude-context") {
    await runClaudeContextHook();
    return;
  }
  if (hook === "claude-stop") {
    await runClaudeStopHook();
    return;
  }
  if (hook === "handoff-status") {
    const sessionId = option(args, "session");
    const agentId = option(args, "agent") ?? "openclaw";
    print(
      {
        recorded:
          sessionId !== undefined &&
          hasHandoff(openDefaultDb(), sessionId, agentId),
      },
      true
    );
    return;
  }
  throw new ValidationError(`Unknown hook '${String(hook)}'`);
}

async function runCodexLauncher(args: ParsedArgs): Promise<void> {
  const task = option(args, "task") ?? args.positionals.join(" ");
  if (task.trim().length === 0) {
    throw new ValidationError("codex launcher requires a task");
  }
  const context = await commandContext(args);
  let retrievedContext: string;
  try {
    const pack = await handlePrepareContext(openDefaultDb(), {
      task,
      user_id: context.userId,
      agent_id: "codex",
      ...(context.projectId !== undefined
        ? { project_id: context.projectId }
        : {}),
      ...(context.sessionId !== undefined
        ? { session_id: context.sessionId }
        : {}),
    });
    retrievedContext = pack.context;
  } catch (error) {
    retrievedContext =
      `[Memryon warning: relevant context could not be loaded: ${errorMessage(
        error
      )}. Continuing without it.]`;
    process.stderr.write(`${retrievedContext}\n`);
  }
  const prompt = buildCodexPrompt(retrievedContext, task);
  const command = process.env["MEMRYON_CODEX_COMMAND"] ?? "codex";

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [prompt], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Codex exited with status ${String(code)}`));
      }
    });
  });
}

export function buildCodexPrompt(context: string, task: string): string {
  return `${context}\n\nUSER_TASK:\n${task}`;
}

function help(): string {
  return `Memryon - local shared project brain

Commands:
  memryon init [--skip-models]
  memryon serve
  memryon doctor
  memryon models install|status
  memryon integrate claude-code|codex|openclaw|hermes
  memryon context <task> [--agent ID] [--token-budget N] [--json]
  memryon handoff --task <task> [--summary text] [--decision text] [--json]
  memryon memories list [--limit N]
  memryon forget <memory-id> [--reason text]
  memryon conflicts
  memryon export [--output file]
  memryon codex <task>`;
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  if (command === undefined || command === "help" || flag(args, "help")) {
    print(help(), false);
    return;
  }
  if (command === "serve") {
    await serveMcpServer();
    return;
  }
  if (command === "init") await runInit(args);
  else if (command === "doctor") await runDoctor(args);
  else if (command === "models") await runModels(args);
  else if (command === "integrate") await runIntegrate(args);
  else if (command === "context") await runContext(args);
  else if (command === "handoff") await runHandoff(args);
  else if (command === "memories") await runMemories(args);
  else if (command === "forget") await runForget(args);
  else if (command === "conflicts") await runConflicts(args);
  else if (command === "export") await runExport(args);
  else if (command === "hook") await runHook(args);
  else if (command === "codex") await runCodexLauncher(args);
  else throw new ValidationError(`Unknown command '${command}'`);
}

const isMain =
  process.argv[1] !== undefined &&
  (await import("node:url")).fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  runCli()
    .catch((error) => {
      process.stderr.write(`memryon: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => {
      closeDb(getDefaultDbPath());
    });
}
