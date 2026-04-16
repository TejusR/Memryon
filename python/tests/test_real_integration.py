from __future__ import annotations

import shutil
import sqlite3
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from typing_extensions import TypedDict

from memryon_langgraph import MemryonStore


REPO_ROOT = Path(__file__).resolve().parents[2]
DIST_SERVER = REPO_ROOT / "dist" / "mcp" / "server.js"
NPM_BIN = shutil.which("npm") or shutil.which("npm.cmd")
NODE_BIN = shutil.which("node")

_BUILT = False


def _ensure_server_build() -> None:
    global _BUILT
    if _BUILT:
        return

    if NPM_BIN is None or NODE_BIN is None:
        pytest.skip("Node.js and npm are required for the real Memryon integration test")

    subprocess.run(
        [NPM_BIN, "run", "build"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    _BUILT = True


def _seed_db(
    db_path: Path,
    *,
    agents: list[tuple[str, str, int]],
    project: tuple[str, str, str] | None = None,
    memberships: list[tuple[str, str, str]] | None = None,
) -> None:
    connection = sqlite3.connect(db_path)
    connection.executescript(
        """
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS agents (
          agent_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          trust_tier INTEGER NOT NULL CHECK (trust_tier IN (1, 2, 3)),
          capabilities TEXT NOT NULL DEFAULT '[]',
          registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          archived_at TEXT
        );
        CREATE TABLE IF NOT EXISTS project_agents (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'contributor' CHECK (role IN ('owner', 'contributor', 'readonly')),
          joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (project_id, agent_id)
        );
        """
    )

    connection.executemany(
        """
        INSERT INTO agents (agent_id, display_name, trust_tier, capabilities)
        VALUES (?, ?, ?, '[]')
        """,
        agents,
    )

    if project is not None:
        connection.execute(
            """
            INSERT INTO projects (id, user_id, name, description)
            VALUES (?, ?, ?, ?)
            """,
            project,
        )

    if memberships:
        connection.executemany(
            """
            INSERT INTO project_agents (project_id, agent_id, role)
            VALUES (?, ?, ?)
            """,
            memberships,
        )

    connection.commit()
    connection.close()


def _make_store(
    db_path: Path,
    *,
    user_id: str,
    agent_id: str,
    project_id: str | None = None,
) -> MemryonStore:
    return MemryonStore.from_stdio(
        user_id=user_id,
        agent_id=agent_id,
        project_id=project_id,
        server_command=NODE_BIN or "node",
        server_args=[str(DIST_SERVER)],
        env={"MEMRYON_DB_PATH": str(db_path)},
    )


def test_real_langgraph_graph_persists_long_term_memory_across_threads() -> None:
    _ensure_server_build()

    with TemporaryDirectory() as temp_dir:
        db_path = Path(temp_dir) / "memryon.db"
        _seed_db(
            db_path,
            agents=[("agent-1", "Agent One", 2)],
        )

        store = _make_store(db_path, user_id="user-1", agent_id="agent-1")

        class State(TypedDict):
            action: str
            key: str
            value: str | None
            loaded: str | None

        def memory_node(state: State, runtime):
            namespace = ("users", "user-1", "memories")
            if state["action"] == "write":
                runtime.store.put(namespace, state["key"], {"memory": state["value"]})
                return {"loaded": state["value"]}

            item = runtime.store.get(namespace, state["key"])
            return {
                "loaded": None if item is None else item.value["memory"],
            }

        builder = StateGraph(State)
        builder.add_node("memory_node", memory_node)
        builder.add_edge(START, "memory_node")
        builder.add_edge("memory_node", END)
        graph = builder.compile(checkpointer=InMemorySaver(), store=store)

        graph.invoke(
            {"action": "write", "key": "favorite_food", "value": "pizza", "loaded": None},
            {"configurable": {"thread_id": "thread-1"}},
        )
        loaded = graph.invoke(
            {"action": "read", "key": "favorite_food", "value": None, "loaded": None},
            {"configurable": {"thread_id": "thread-2"}},
        )

        assert loaded["loaded"] == "pizza"


def test_real_store_respects_project_sharing_and_agent_privacy() -> None:
    _ensure_server_build()

    with TemporaryDirectory() as temp_dir:
        db_path = Path(temp_dir) / "memryon.db"
        _seed_db(
            db_path,
            agents=[
                ("agent-1", "Agent One", 2),
                ("agent-2", "Agent Two", 2),
            ],
            project=("project-1", "user-1", "Shared Project", ""),
            memberships=[
                ("project-1", "agent-1", "owner"),
                ("project-1", "agent-2", "contributor"),
            ],
        )

        project_store_a = _make_store(
            db_path, user_id="user-1", agent_id="agent-1", project_id="project-1"
        )
        project_store_b = _make_store(
            db_path, user_id="user-1", agent_id="agent-2", project_id="project-1"
        )

        project_store_a.put(("shared", "facts"), "rollout", {"status": "green"})
        shared = project_store_b.get(("shared", "facts"), "rollout")

        private_store_a = _make_store(db_path, user_id="user-1", agent_id="agent-1")
        private_store_b = _make_store(db_path, user_id="user-1", agent_id="agent-2")
        private_store_a.put(("private", "notes"), "plan", {"text": "keep secret"})
        hidden = private_store_b.get(("private", "notes"), "plan")

        assert shared is not None
        assert shared.value == {"status": "green"}
        assert hidden is None
