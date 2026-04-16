from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone

import pytest
from langgraph.store.base import GetOp, ListNamespacesOp, MatchCondition, PutOp, SearchOp

from memryon_langgraph import MemryonConfig, MemryonStore, MemryonStoreError


@dataclass
class _StoredItem:
    namespace: tuple[str, ...]
    key: str
    value: dict
    created_at: str
    updated_at: str
    deleted: bool = False


class FakeMemryonClient:
    def __init__(self) -> None:
        self.started = 0
        self.stopped = 0
        self.calls: list[tuple[str, dict]] = []
        self.items: dict[tuple[tuple[str, ...], str], _StoredItem] = {}

    async def start(self) -> None:
        self.started += 1

    async def stop(self) -> None:
        self.stopped += 1

    async def call_tool(self, name: str, args: dict) -> dict:
        self.calls.append((name, args))
        now = datetime.now(timezone.utc).isoformat()

        if name == "store_put":
            namespace = tuple(args["namespace"])
            key = args["key"]
            existing = self.items.get((namespace, key))
            created_at = existing.created_at if existing else now
            self.items[(namespace, key)] = _StoredItem(
                namespace=namespace,
                key=key,
                value=args["value_json"],
                created_at=created_at,
                updated_at=now,
            )
            item = self.items[(namespace, key)]
            return {
                "status": "stored",
                "item": self._public_item(item),
                "memcell_id": f"mem-{key}",
                "candidates_buffered": 1,
            }

        if name == "store_get":
            item = self.items.get((tuple(args["namespace"]), args["key"]))
            return {"item": None if item is None or item.deleted else self._public_item(item)}

        if name == "store_search":
            prefix = tuple(args["namespace_prefix"])
            query = args.get("query")
            matches = [
                self._public_item(item)
                for item in self.items.values()
                if not item.deleted
                and item.namespace[: len(prefix)] == prefix
                and (
                    query is None
                    or query.lower() in str(item.value).lower()
                )
            ]
            return {"items": matches}

        if name == "store_delete":
            item = self.items.get((tuple(args["namespace"]), args["key"]))
            if item is None or item.deleted:
                return {
                    "status": "not_found",
                    "key": args["key"],
                    "namespace": args["namespace"],
                }
            item.deleted = True
            item.updated_at = now
            return {
                "status": "deleted",
                "key": item.key,
                "namespace": list(item.namespace),
                "memcell_id": f"mem-{item.key}",
            }

        if name == "store_list_namespaces":
            namespaces = sorted(
                {
                    item.namespace[: args.get("max_depth")]
                    if args.get("max_depth") is not None
                    else item.namespace
                    for item in self.items.values()
                    if not item.deleted
                }
            )
            prefix = tuple(args["prefix"]) if "prefix" in args else None
            if prefix is not None:
                namespaces = [
                    namespace
                    for namespace in namespaces
                    if namespace[: len(prefix)] == prefix
                ]
            return {"namespaces": [list(namespace) for namespace in namespaces]}

        raise AssertionError(f"Unexpected tool call: {name}")

    @staticmethod
    def _public_item(item: _StoredItem) -> dict:
        return {
            "key": item.key,
            "namespace": list(item.namespace),
            "value_json": item.value,
            "created_at": item.created_at,
            "updated_at": item.updated_at,
        }


def test_memryon_store_round_trips_put_get_search_delete() -> None:
    client = FakeMemryonClient()
    store = MemryonStore(
        MemryonConfig(user_id="user-1", agent_id="agent-1"),
        client=client,
    )

    store.put(("users", "user-1", "prefs"), "theme", {"mode": "dark"})
    item = store.get(("users", "user-1", "prefs"), "theme")
    results = store.search(("users", "user-1"), query="dark")
    namespaces = store.list_namespaces(prefix=("users", "user-1"), max_depth=3)
    store.delete(("users", "user-1", "prefs"), "theme")

    assert item is not None
    assert item.key == "theme"
    assert item.namespace == ("users", "user-1", "prefs")
    assert item.value == {"mode": "dark"}
    assert len(results) == 1
    assert results[0].value == {"mode": "dark"}
    assert namespaces == [("users", "user-1", "prefs")]
    assert store.get(("users", "user-1", "prefs"), "theme") is None


def test_abatch_supports_current_langgraph_ops() -> None:
    client = FakeMemryonClient()
    store = MemryonStore(
        MemryonConfig(user_id="user-1", agent_id="agent-1"),
        client=client,
    )

    results = asyncio.run(
        store.abatch(
            [
                PutOp(("users", "user-1", "prefs"), "theme", {"mode": "dark"}),
                GetOp(("users", "user-1", "prefs"), "theme"),
                SearchOp(("users", "user-1"), query="dark"),
                ListNamespacesOp(
                    match_conditions=(
                        MatchCondition(match_type="prefix", path=("users", "user-1")),
                    ),
                    max_depth=3,
                ),
            ]
        )
    )

    assert results[0] is None
    assert results[1].value == {"mode": "dark"}
    assert len(results[2]) == 1
    assert results[3] == [("users", "user-1", "prefs")]


def test_from_env_resolves_expected_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MEMRYON_USER_ID", "user-1")
    monkeypatch.setenv("MEMRYON_AGENT_ID", "agent-1")
    monkeypatch.setenv("MEMRYON_PROJECT_ID", "project-1")
    monkeypatch.setenv("MEMRYON_SCOPE", "project")
    monkeypatch.setenv("MEMRYON_SESSION_ID", "session-1")
    monkeypatch.setenv("MEMRYON_SERVER_COMMAND", "node")
    monkeypatch.setenv("MEMRYON_SERVER_ARGS", "[\"dist/mcp/server.js\"]")
    monkeypatch.setenv("MEMRYON_SERVER_ENV", "{\"MEMRYON_DB_PATH\":\"memryon.db\"}")

    store = MemryonStore.from_env()

    assert store.config.user_id == "user-1"
    assert store.config.agent_id == "agent-1"
    assert store.config.project_id == "project-1"
    assert store.config.resolved_scope() == "project"
    assert store.config.server_command == "node"
    assert store.config.server_args == ["dist/mcp/server.js"]
    assert store.config.env == {"MEMRYON_DB_PATH": "memryon.db"}


def test_from_stdio_uses_underlying_client_lifecycle(monkeypatch: pytest.MonkeyPatch) -> None:
    created: list[FakeMemryonClient] = []

    class FactoryClient(FakeMemryonClient):
        def __init__(self, *args, **kwargs) -> None:
            super().__init__()
            created.append(self)

    monkeypatch.setattr("memryon_langgraph.store.StdioMemryonClient", FactoryClient)

    store = MemryonStore.from_stdio(
        user_id="user-1",
        agent_id="agent-1",
        server_command="node",
        server_args=["dist/mcp/server.js"],
    )

    asyncio.run(store.start())
    asyncio.run(store.stop())

    assert len(created) == 1
    assert created[0].started == 1
    assert created[0].stopped == 1


def test_connector_surfaces_memryon_failures() -> None:
    class FailingClient(FakeMemryonClient):
        async def call_tool(self, name: str, args: dict) -> dict:
            raise MemryonStoreError("transport failed")

    store = MemryonStore(
        MemryonConfig(user_id="user-1", agent_id="agent-1"),
        client=FailingClient(),
    )

    with pytest.raises(MemryonStoreError, match="transport failed"):
        store.get(("users", "user-1"), "prefs")
