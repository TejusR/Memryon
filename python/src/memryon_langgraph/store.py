from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any, Iterable, cast
from uuid import uuid4

from langgraph.store.base import (
    BaseStore,
    GetOp,
    Item,
    ListNamespacesOp,
    Op,
    PutOp,
    Result,
    SearchItem,
    SearchOp,
)

from .config import MemryonConfig
from .errors import MemryonStoreError
from .mcp_client import MemryonMCPClient, StdioMemryonClient


def _parse_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class MemryonStore(BaseStore):
    def __init__(
        self,
        config: MemryonConfig,
        *,
        client: MemryonMCPClient | None = None,
    ) -> None:
        self.config = config
        self._client = client or StdioMemryonClient(
            command=config.server_command or "",
            args=config.server_args,
            env=config.env,
        )

    @classmethod
    def from_stdio(
        cls,
        *,
        user_id: str,
        agent_id: str,
        server_command: str,
        server_args: list[str] | None = None,
        project_id: str | None = None,
        scope: str | None = None,
        session_id: str | None = None,
        env: dict[str, str] | None = None,
    ) -> "MemryonStore":
        config = MemryonConfig(
            user_id=user_id,
            agent_id=agent_id,
            project_id=project_id,
            scope=scope,
            session_id=session_id or f"langgraph-{uuid4().hex}",
            server_command=server_command,
            server_args=server_args or [],
            env=env,
        )
        return cls(config)

    @classmethod
    def from_env(cls) -> "MemryonStore":
        return cls(MemryonConfig.from_env())

    async def start(self) -> None:
        await self._client.start()

    async def stop(self) -> None:
        await self._client.stop()

    async def __aenter__(self) -> "MemryonStore":
        await self.start()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.stop()

    def batch(self, ops: Iterable[Op]) -> list[Result]:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            operations = list(ops)
            if isinstance(self._client, StdioMemryonClient):
                return asyncio.run(self._run_sync_stdio_batch(operations))
            return asyncio.run(self.abatch(operations))

        raise MemryonStoreError(
            "MemryonStore.batch() cannot be used from an active event loop; use abatch()"
        )

    async def abatch(self, ops: Iterable[Op]) -> list[Result]:
        results: list[Result] = []
        for op in ops:
            results.append(await self._execute_op(op))
        return results

    async def _run_sync_stdio_batch(self, ops: list[Op]) -> list[Result]:
        client = StdioMemryonClient(
            command=self.config.server_command or "",
            args=self.config.server_args,
            env=self.config.env,
        )
        results: list[Result] = []

        try:
            await client.start()
            for op in ops:
                results.append(await self._execute_op(op, client=client))
        finally:
            await client.stop()

        return results

    def _base_args(self) -> dict[str, Any]:
        args: dict[str, Any] = {
            "user_id": self.config.user_id,
            "agent_id": self.config.agent_id,
            "scope": self.config.resolved_scope(),
        }
        if self.config.project_id is not None:
            args["project_id"] = self.config.project_id
        return args

    async def _execute_op(
        self, op: Op, *, client: MemryonMCPClient | None = None
    ) -> Result:
        active_client = client or self._client

        if isinstance(op, GetOp):
            payload = await active_client.call_tool(
                "store_get",
                {
                    **self._base_args(),
                    "namespace": list(op.namespace),
                    "key": op.key,
                },
            )
            raw_item = payload.get("item")
            return None if raw_item is None else self._to_item(cast(dict[str, Any], raw_item))

        if isinstance(op, SearchOp):
            payload = await active_client.call_tool(
                "store_search",
                {
                    **self._base_args(),
                    "namespace_prefix": list(op.namespace_prefix),
                    "limit": op.limit,
                    "offset": op.offset,
                    **({"query": op.query} if op.query is not None else {}),
                    **({"filter_json": op.filter} if op.filter is not None else {}),
                },
            )
            return [
                self._to_search_item(cast(dict[str, Any], item))
                for item in cast(list[dict[str, Any]], payload.get("items", []))
            ]

        if isinstance(op, PutOp):
            if op.ttl is not None:
                raise MemryonStoreError("TTL is not supported by MemryonStore")

            if op.value is None:
                await active_client.call_tool(
                    "store_delete",
                    {
                        **self._base_args(),
                        "namespace": list(op.namespace),
                        "key": op.key,
                    },
                )
                return None

            metadata_json: dict[str, Any] | None = None
            if op.index is not None:
                metadata_json = {"langgraph_index": op.index}

            await active_client.call_tool(
                "store_put",
                {
                    **self._base_args(),
                    "namespace": list(op.namespace),
                    "key": op.key,
                    "value_json": op.value,
                    "session_id": self.config.session_id,
                    **(
                        {"metadata_json": metadata_json}
                        if metadata_json is not None
                        else {}
                    ),
                },
            )
            return None

        if isinstance(op, ListNamespacesOp):
            prefix: tuple[str, ...] | None = None
            suffix: tuple[str, ...] | None = None
            for condition in op.match_conditions or ():
                if condition.match_type == "prefix":
                    prefix = tuple(condition.path)
                elif condition.match_type == "suffix":
                    suffix = tuple(condition.path)

            payload = await active_client.call_tool(
                "store_list_namespaces",
                {
                    **self._base_args(),
                    **({"prefix": list(prefix)} if prefix is not None else {}),
                    **({"suffix": list(suffix)} if suffix is not None else {}),
                    **(
                        {"max_depth": op.max_depth}
                        if op.max_depth is not None
                        else {}
                    ),
                    "limit": op.limit,
                    "offset": op.offset,
                },
            )
            return [tuple(namespace) for namespace in payload.get("namespaces", [])]

        raise MemryonStoreError(f"Unsupported LangGraph store operation: {op!r}")

    def _to_item(self, raw_item: dict[str, Any]) -> Item:
        return Item(
            value=cast(dict[str, Any], raw_item["value_json"]),
            key=cast(str, raw_item["key"]),
            namespace=tuple(cast(list[str], raw_item["namespace"])),
            created_at=_parse_datetime(cast(str, raw_item["created_at"])),
            updated_at=_parse_datetime(cast(str, raw_item["updated_at"])),
        )

    def _to_search_item(self, raw_item: dict[str, Any]) -> SearchItem:
        score = raw_item.get("score")
        parsed_score = float(score) if isinstance(score, (int, float)) else None
        return SearchItem(
            value=cast(dict[str, Any], raw_item["value_json"]),
            key=cast(str, raw_item["key"]),
            namespace=tuple(cast(list[str], raw_item["namespace"])),
            created_at=_parse_datetime(cast(str, raw_item["created_at"])),
            updated_at=_parse_datetime(cast(str, raw_item["updated_at"])),
            score=parsed_score,
        )
