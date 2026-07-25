import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { closeDb, getDb } from "../../src/db/connection.js";
import { installIntegration } from "../../src/integrations/install.js";

const DB = ":memory:";
let db: ReturnType<typeof getDb>;
let projectRoot: string;

beforeEach(async () => {
  db = getDb(DB);
  projectRoot = await mkdtemp(path.join(process.cwd(), ".tmp-integration-"));
});

afterEach(async () => {
  closeDb(DB);
  await rm(projectRoot, { recursive: true, force: true });
});

describe("integration installers", () => {
  it("merges Claude MCP and hook JSON without discarding user settings", async () => {
    await writeFile(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { existing: { command: "existing" } } }),
      "utf8"
    );

    await installIntegration(db, "claude-code", projectRoot);
    await installIntegration(db, "claude-code", projectRoot);

    const mcp = JSON.parse(
      await readFile(path.join(projectRoot, ".mcp.json"), "utf8")
    ) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    const settings = JSON.parse(
      await readFile(
        path.join(projectRoot, ".claude", "settings.json"),
        "utf8"
      )
    ) as { hooks: Record<string, unknown[]> };

    expect(mcp.mcpServers["existing"]?.command).toBe("existing");
    expect(mcp.mcpServers["memryon"]).toMatchObject({
      command: "memryon",
      args: ["serve"],
    });
    expect(settings.hooks["SessionStart"]).toHaveLength(1);
    expect(settings.hooks["UserPromptSubmit"]).toHaveLength(1);
    expect(settings.hooks["Stop"]).toHaveLength(1);
  });

  it("installs idempotent Codex MCP config and durable AGENTS guidance", async () => {
    await writeFile(
      path.join(projectRoot, "AGENTS.md"),
      "# Existing guidance\n",
      "utf8"
    );

    await installIntegration(db, "codex", projectRoot);
    await installIntegration(db, "codex", projectRoot);

    const config = await readFile(
      path.join(projectRoot, ".codex", "config.toml"),
      "utf8"
    );
    const agents = await readFile(
      path.join(projectRoot, "AGENTS.md"),
      "utf8"
    );

    expect(config.match(/\[mcp_servers\.memryon\]/g)).toHaveLength(1);
    expect(agents).toContain("# Existing guidance");
    expect(agents.match(/<!-- memryon:start -->/g)).toHaveLength(1);
    expect(agents).toContain("prepare_context");
    expect(agents).toContain("record_handoff");
  });

  it("ships automatic OpenClaw and Hermes lifecycle templates", async () => {
    const openClaw = await readFile(
      path.join(process.cwd(), "integrations", "openclaw", "index.js"),
      "utf8"
    );
    const hermes = await readFile(
      path.join(process.cwd(), "integrations", "hermes", "__init__.py"),
      "utf8"
    );

    expect(openClaw).toContain('"agent_turn_prepare"');
    expect(openClaw).toContain("prependContext");
    expect(openClaw).toContain('"before_agent_finalize"');
    expect(openClaw).toContain("record_handoff");
    expect(openClaw).not.toContain("PostToolUse");
    expect(hermes).toContain("def prepareContext");
    expect(hermes).toContain("def recordHandoff");
    expect(hermes).toContain("def prefetch");
    expect(hermes).toContain("def store");
    expect(hermes).toContain("def retrieve");
    expect(hermes).toContain("def delete");
  });
});
