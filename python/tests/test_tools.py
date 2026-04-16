from __future__ import annotations

from dataclasses import dataclass

from langchain_mcp_adapters.interceptors import MCPToolCallRequest

from memryon_langgraph import MemryonConfig, load_memryon_tools
from memryon_langgraph.tools import _identity_injector


@dataclass
class FakeTool:
    name: str


def test_identity_injector_merges_default_context() -> None:
    config = MemryonConfig(
        user_id="user-1",
        agent_id="agent-1",
        project_id="project-1",
        server_command="node",
        server_args=["dist/mcp/server.js"],
    )
    interceptor = _identity_injector(config)

    async def handler(request: MCPToolCallRequest):
        return request.args

    result = __import__("asyncio").run(
        interceptor(
            MCPToolCallRequest(
                name="remember",
                args={"content": "hello"},
                server_name="memryon",
            ),
            handler,
        )
    )

    assert result["content"] == "hello"
    assert result["user_id"] == "user-1"
    assert result["agent_id"] == "agent-1"
    assert result["project_id"] == "project-1"
    assert result["scope"] == "project"
    assert "session_id" in result


def test_load_memryon_tools_filters_store_plumbing(monkeypatch) -> None:
    async def fake_get_tools(self, *, server_name=None):
        return [FakeTool("remember"), FakeTool("recall"), FakeTool("store_put")]

    monkeypatch.setattr(
        "langchain_mcp_adapters.client.MultiServerMCPClient.get_tools",
        fake_get_tools,
    )

    config = MemryonConfig(
        user_id="user-1",
        agent_id="agent-1",
        server_command="node",
        server_args=["dist/mcp/server.js"],
    )

    tools = __import__("asyncio").run(load_memryon_tools(config))

    assert [tool.name for tool in tools] == ["remember", "recall"]
