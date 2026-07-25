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
        session_id="session-1",
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
    assert result["session_id"] == "session-1"


def test_identity_injector_supplies_context_and_handoff_identity() -> None:
    config = MemryonConfig(
        user_id="user-1",
        agent_id="agent-1",
        project_id="project-1",
        session_id="session-1",
        server_command="node",
        server_args=["dist/mcp/server.js"],
    )
    interceptor = _identity_injector(config)

    async def handler(request: MCPToolCallRequest):
        return request.args

    async def invoke(name: str, args: dict):
        return await interceptor(
            MCPToolCallRequest(
                name=name,
                args=args,
                server_name="memryon",
            ),
            handler,
        )

    asyncio = __import__("asyncio")
    context = asyncio.run(invoke("prepare_context", {"task": "Resume work"}))
    handoff = asyncio.run(
        invoke(
            "record_handoff",
            {"task": "Resume work", "summary": "Finished"},
        )
    )

    for result in (context, handoff):
        assert result["user_id"] == "user-1"
        assert result["agent_id"] == "agent-1"
        assert result["project_id"] == "project-1"
        assert result["session_id"] == "session-1"
        assert "scope" not in result


def test_load_memryon_tools_filters_store_plumbing(monkeypatch) -> None:
    async def fake_get_tools(self, *, server_name=None):
        return [
            FakeTool("remember"),
            FakeTool("recall"),
            FakeTool("prepare_context"),
            FakeTool("record_handoff"),
            FakeTool("store_put"),
        ]

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

    assert [tool.name for tool in tools] == [
        "remember",
        "recall",
        "prepare_context",
        "record_handoff",
    ]
