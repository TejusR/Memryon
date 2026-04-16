from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Mapping
from uuid import uuid4


@dataclass(slots=True)
class MemryonConfig:
    user_id: str
    agent_id: str
    project_id: str | None = None
    scope: str | None = None
    session_id: str = field(default_factory=lambda: f"langgraph-{uuid4().hex}")
    server_command: str | None = None
    server_args: list[str] = field(default_factory=list)
    env: dict[str, str] | None = None

    def resolved_scope(self) -> str:
        return self.scope or ("project" if self.project_id else "agent")

    @classmethod
    def from_env(cls) -> "MemryonConfig":
        user_id = os.environ["MEMRYON_USER_ID"]
        agent_id = os.environ["MEMRYON_AGENT_ID"]
        server_command = os.environ.get("MEMRYON_SERVER_COMMAND")
        raw_args = os.environ.get("MEMRYON_SERVER_ARGS", "[]")
        raw_env = os.environ.get("MEMRYON_SERVER_ENV")

        parsed_args = json.loads(raw_args)
        if not isinstance(parsed_args, list) or not all(
            isinstance(item, str) for item in parsed_args
        ):
            raise ValueError("MEMRYON_SERVER_ARGS must be a JSON array of strings")

        parsed_env: dict[str, str] | None = None
        if raw_env is not None:
            env_obj = json.loads(raw_env)
            if not isinstance(env_obj, dict) or not all(
                isinstance(key, str) and isinstance(value, str)
                for key, value in env_obj.items()
            ):
                raise ValueError("MEMRYON_SERVER_ENV must be a JSON object of strings")
            parsed_env = dict(env_obj)

        return cls(
            user_id=user_id,
            agent_id=agent_id,
            project_id=os.environ.get("MEMRYON_PROJECT_ID"),
            scope=os.environ.get("MEMRYON_SCOPE"),
            session_id=os.environ.get("MEMRYON_SESSION_ID", f"langgraph-{uuid4().hex}"),
            server_command=server_command,
            server_args=list(parsed_args),
            env=parsed_env,
        )

    def merged_env(
        self, extra: Mapping[str, str] | None = None
    ) -> dict[str, str] | None:
        if self.env is None and extra is None:
            return None

        merged: dict[str, str] = {}
        if self.env is not None:
            merged.update(self.env)
        if extra is not None:
            merged.update(extra)
        return merged
