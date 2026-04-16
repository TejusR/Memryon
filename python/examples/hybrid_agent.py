from memryon_langgraph import MemryonConfig, MemryonStore, load_memryon_tools


async def build_components():
    config = MemryonConfig(
        user_id="user-123",
        agent_id="agent-abc",
        project_id="project-xyz",
        server_command="node",
        server_args=["/absolute/path/to/memryon/dist/mcp/server.js"],
    )

    store = MemryonStore(config)
    tools = await load_memryon_tools(config)
    return store, tools
