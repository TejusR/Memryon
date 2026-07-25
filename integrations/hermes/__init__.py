"""Hermes MemoryProvider bridge for the local Memryon CLI."""

from __future__ import annotations

import json
import shutil
import subprocess
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider


class MemryonProvider(MemoryProvider):
    def __init__(self) -> None:
        self._session_id = ""

    @property
    def name(self) -> str:
        return "memryon"

    def is_available(self) -> bool:
        return shutil.which("memryon") is not None

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._session_id = session_id

    def system_prompt_block(self) -> str:
        return (
            "Memryon supplies retrieved project evidence before each turn. "
            "After substantive work, call record_handoff once with concise "
            "decisions, constraints, failures, outcomes, and unresolved questions. "
            "Never store hidden reasoning."
        )

    def _run(self, args: List[str]) -> Dict[str, Any]:
        completed = subprocess.run(
            ["memryon", *args, "--json"],
            check=True,
            capture_output=True,
            text=True,
            timeout=3,
        )
        return json.loads(completed.stdout)

    def prepareContext(self, task: str, session_id: str = "") -> str:
        try:
            result = self._run(
                [
                    "context",
                    task,
                    "--user",
                    "local-user",
                    "--agent",
                    "hermes",
                    "--session",
                    session_id or self._session_id,
                ]
            )
            return str(result.get("context", ""))
        except Exception as exc:
            return (
                "[Memryon warning: relevant context could not be loaded: "
                f"{exc}. Continuing without it.]"
            )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        return self.prepareContext(query, session_id)

    def retrieve(self, query: str, **kwargs: Any) -> str:
        return self.prepareContext(
            query,
            str(kwargs.get("session_id") or self._session_id),
        )

    def store(self, content: str, **kwargs: Any) -> Dict[str, Any]:
        task = str(kwargs.get("task") or "Store a durable Hermes memory")
        return self.recordHandoff(
            {
                "task": task,
                "summary": content,
                "session_id": kwargs.get("session_id") or self._session_id,
            }
        )

    def delete(self, memory_id: str, **kwargs: Any) -> bool:
        try:
            result = self._run(
                [
                    "forget",
                    memory_id,
                    "--agent",
                    "hermes",
                    "--reason",
                    str(kwargs.get("reason") or "Deleted through Hermes"),
                ]
            )
            return result.get("status") == "forgotten"
        except Exception:
            return False

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        # Raw turns and tool output are intentionally not durable memories.
        return None

    def recordHandoff(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        body = {
            **payload,
            "summary": payload.get("summary", ""),
            "user_id": "local-user",
            "agent_id": "hermes",
            "framework": "hermes",
            "session_id": payload.get("session_id") or self._session_id,
        }
        return self._run(["handoff", "--json-input", json.dumps(body)])

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": "record_handoff",
                "description": (
                    "Record durable task decisions, constraints, failures, "
                    "outcomes, and unresolved questions for other agents."
                ),
                "parameters": {
                    "type": "object",
                    "required": ["task"],
                    "properties": {
                        "task": {"type": "string"},
                        "summary": {"type": "string"},
                        "decisions": {"type": "array", "items": {"type": "string"}},
                        "constraints": {"type": "array", "items": {"type": "string"}},
                        "failures": {"type": "array", "items": {"type": "string"}},
                        "outcomes": {"type": "array", "items": {"type": "string"}},
                        "unresolved_questions": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "evidence_refs": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                },
            }
        ]

    def handle_tool_call(
        self, tool_name: str, args: Dict[str, Any], **kwargs: Any
    ) -> str:
        if tool_name != "record_handoff":
            raise ValueError(f"Unsupported Memryon tool: {tool_name}")
        return json.dumps(self.recordHandoff(args))

    def shutdown(self) -> None:
        return None


def register(ctx: Any) -> None:
    ctx.register_memory_provider(MemryonProvider())
