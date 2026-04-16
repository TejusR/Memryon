# Memryon LangGraph Connector

`memryon-langgraph` provides a native LangGraph long-term store backed by Memryon over MCP.

## Quickstart

```python
from memryon_langgraph import MemryonStore

store = MemryonStore.from_stdio(
    user_id="user-123",
    agent_id="agent-abc",
    project_id="project-xyz",
    server_command="node",
    server_args=["/absolute/path/to/memryon/dist/mcp/server.js"],
)

graph = builder.compile(store=store)
```

This connector only manages long-term memory. Keep using LangGraph checkpointers for thread checkpoints and replay.

## Hybrid Example

```python
from memryon_langgraph import MemryonConfig, MemryonStore, load_memryon_tools

config = MemryonConfig(
    user_id="user-123",
    agent_id="agent-abc",
    project_id="project-xyz",
    server_command="node",
    server_args=["/absolute/path/to/memryon/dist/mcp/server.js"],
)

store = MemryonStore(config)
tools = await load_memryon_tools(config)

graph = builder.compile(store=store)
agent = create_agent("claude-sonnet-4-6", tools=tools, store=store)
```

The optional MCP tool bridge exposes Memryon’s semantic tools like `remember`, `recall`, and `conflicts`, but hides the low-level `store_*` plumbing tools used by the native store adapter.
