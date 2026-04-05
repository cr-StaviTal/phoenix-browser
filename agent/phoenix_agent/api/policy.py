"""Policy management endpoints."""
import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException

from phoenix_agent.config import settings
from phoenix_agent.models.policy import PolicyConfig

router = APIRouter(tags=["policy"])

_current_policy: PolicyConfig | None = None


def _load_default_policy() -> PolicyConfig:
    """Load default policy from file."""
    policy_path = Path(settings.policy_path)
    if policy_path.exists():
        with open(policy_path) as f:
            data = json.load(f)
            return PolicyConfig(**data)
    return PolicyConfig()


def get_current_policy() -> PolicyConfig:
    """Get the current active policy."""
    global _current_policy
    if _current_policy is None:
        _current_policy = _load_default_policy()
    return _current_policy


@router.get("/policy")
async def get_policy():
    """Get the current policy configuration."""
    policy = get_current_policy()
    return policy.model_dump()


@router.put("/policy")
async def update_policy(new_policy: PolicyConfig):
    """Update the policy configuration."""
    global _current_policy
    new_policy.updated_at = datetime.now(timezone.utc).isoformat()
    _current_policy = new_policy

    # Persist to file
    policy_path = Path(settings.policy_path)
    policy_path.parent.mkdir(parents=True, exist_ok=True)
    with open(policy_path, "w") as f:
        json.dump(new_policy.model_dump(), f, indent=2)

    return {"version": new_policy.version, "updated_at": new_policy.updated_at}
