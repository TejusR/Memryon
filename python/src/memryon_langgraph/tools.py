from __future__ import annotations

from typing import Any

from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.interceptors import MCPToolCallRequest

from .config import MemryonConfig
from .errors import MemryonStoreError


def _memryon_connection(config: MemryonConfig) -> dict[str, Any]:
    if not config.server_command:
        raise MemryonStoreError(
            "MemryonConfig.server_command is required to load MCP tools"
        )

    connection: dict[str, Any] = {
        "transport": "stdio",
        "command": config.server_command,
        "args": config.server_args,
    }
    if config.env is not None:
        connection["env"] = config.env
    return connection


def _tool_defaults(config: MemryonConfig, tool_name: str) -> dict[str, Any]:
    base = {
        "user_id": config.user_id,
        "agent_id": config.agent_id,
    }
    scoped = {
        **base,
        "scope": config.resolved_scope(),
        **({"project_id": config.project_id} if config.project_id is not None else {}),
    }

    if tool_name in {"remember"}:
        return {
            **scoped,
            "session_id": config.session_id,
        }
    if tool_name in {"recall", "store_get", "store_search", "store_list_namespaces"}:
        return scoped
    if tool_name in {"forget", "corroborate", "promote", "store_delete"}:
        return base | (
            {"project_id": config.project_id}
            if config.project_id is not None and tool_name == "store_delete"
            else {}
        )
    if tool_name in {"conflicts", "project_context"} and config.project_id is not None:
        return {**base, "project_id": config.project_id}
    if tool_name == "project_create":
        return base
    if tool_name == "project_join":
        return {"agent_id": config.agent_id}
    return {}


def _identity_injector(config: MemryonConfig):
    async def interceptor(request: MCPToolCallRequest, handler):
        defaults = _tool_defaults(config, request.name)
        merged_args = {**defaults, **request.args}
        return await handler(request.override(args=merged_args))

    return interceptor


async def load_memryon_tools(config: MemryonConfig) -> list[BaseTool]:
    client = MultiServerMCPClient(
        {
            "memryon": _memryon_connection(config),
        },
        tool_interceptors=[_identity_injector(config)],
    )
    tools = await client.get_tools(server_name="memryon")
    return [tool for tool in tools if not tool.name.startswith("store_")]
