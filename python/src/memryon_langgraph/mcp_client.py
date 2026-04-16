from __future__ import annotations

import asyncio
import json
from contextlib import AsyncExitStack
from typing import Any, Protocol

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from .errors import MemryonStoreError


class MemryonMCPClient(Protocol):
    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    async def call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]: ...


class StdioMemryonClient:
    def __init__(
        self,
        *,
        command: str,
        args: list[str] | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        self._command = command
        self._args = args or []
        self._env = env
        self._stack: AsyncExitStack | None = None
        self._session: ClientSession | None = None
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        async with self._lock:
            if self._session is not None:
                return

            if not self._command:
                raise MemryonStoreError(
                    "Memryon stdio client requires a server command"
                )

            stack = AsyncExitStack()
            server = StdioServerParameters(
                command=self._command,
                args=self._args,
                env=self._env,
            )
            read_stream, write_stream = await stack.enter_async_context(
                stdio_client(server)
            )
            session = ClientSession(read_stream, write_stream)
            await stack.enter_async_context(session)
            await session.initialize()

            self._stack = stack
            self._session = session

    async def stop(self) -> None:
        async with self._lock:
            if self._stack is not None:
                await self._stack.aclose()
            self._stack = None
            self._session = None

    async def call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        await self.start()

        if self._session is None:
            raise MemryonStoreError("Memryon MCP session is not available")

        result = await self._session.call_tool(name, arguments=args)
        text_block = next(
            (
                block
                for block in result.content
                if getattr(block, "type", None) == "text"
                and isinstance(getattr(block, "text", None), str)
            ),
            None,
        )

        if text_block is None:
            raise MemryonStoreError(
                f"Memryon tool '{name}' did not return a text payload"
            )

        payload = json.loads(text_block.text)
        if result.isError:
            raise MemryonStoreError(str(payload.get("error", f"Tool '{name}' failed")))

        if not isinstance(payload, dict):
            raise MemryonStoreError(
                f"Memryon tool '{name}' returned a non-object payload"
            )

        return payload
