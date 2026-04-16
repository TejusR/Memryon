from memryon_langgraph import MemryonStore


def build_store() -> MemryonStore:
    return MemryonStore.from_stdio(
        user_id="user-123",
        agent_id="agent-abc",
        project_id="project-xyz",
        server_command="node",
        server_args=["/absolute/path/to/memryon/dist/mcp/server.js"],
    )
