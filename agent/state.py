"""Agent state persistence (Supabase agent_state and agent_logs tables)."""

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from supabase import Client, create_client


def _get_client() -> Client:
    url = os.environ.get("SUPABASE_URL", "https://nzdkoouoaedbbccraoti.supabase.co")
    key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_KEY", "")
    if not key:
        raise RuntimeError("SUPABASE_SERVICE_KEY not set")
    return create_client(url, key)


def load_state() -> dict[str, Any]:
    """Load all persistent agent state from Supabase."""
    client = _get_client()
    rows = client.table("agent_state").select("key,value").execute().data
    return {r["key"]: r["value"] for r in rows}


def set_state(key: str, value: Any) -> None:
    """Upsert a single state key."""
    client = _get_client()
    client.table("agent_state").upsert({
        "key": key,
        "value": value,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).execute()


def start_run() -> str:
    """Create an agent_logs row and return the run_id."""
    client = _get_client()
    run_id = str(uuid.uuid4())
    client.table("agent_logs").insert({
        "run_id": run_id,
        "status": "running",
    }).execute()
    return run_id


def finish_run(
    run_id: str,
    status: str,
    claude_plan: Optional[Any] = None,
    actions_taken: Optional[list] = None,
    outcomes: Optional[list] = None,
    errors: Optional[list] = None,
    summary: Optional[str] = None,
) -> None:
    """Update the agent_logs row with final results."""
    client = _get_client()
    update: dict[str, Any] = {
        "status": status,
        "run_completed_at": datetime.now(timezone.utc).isoformat(),
    }
    if claude_plan is not None:
        update["claude_plan"] = _sanitize(claude_plan)
    if actions_taken is not None:
        update["actions_taken"] = _sanitize(actions_taken)
    if outcomes is not None:
        update["outcomes"] = _sanitize(outcomes)
    if errors is not None:
        update["errors"] = _sanitize(errors)
    if summary is not None:
        update["summary"] = summary
    client.table("agent_logs").update(update).eq("run_id", run_id).execute()


def _sanitize(obj: Any) -> Any:
    """Ensure an object is JSON-serializable for Supabase JSONB columns."""
    try:
        json.dumps(obj)
        return obj
    except (TypeError, ValueError):
        return json.loads(json.dumps(obj, default=str))
