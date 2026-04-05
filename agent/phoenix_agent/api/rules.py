"""Rule management endpoints."""
from fastapi import APIRouter, HTTPException, Query

from phoenix_agent.models.rules import (
    PhoenixRule,
    RuleCreate,
    RuleUpdate,
)
from phoenix_agent.storage import rule_store

router = APIRouter(tags=["rules"])


@router.get("/rules")
async def list_rules(enabled: bool | None = Query(None)):
    """List all rules, optionally filtered by enabled status."""
    rules = await rule_store.list_rules(enabled_only=bool(enabled) if enabled is not None else False)
    return {"rules": rules, "total": len(rules)}


@router.get("/rules/export")
async def export_rules():
    """Export all rules as a JSON array."""
    rules = await rule_store.list_rules()
    return rules


@router.post("/rules/import")
async def import_rules(rules: list[RuleCreate]):
    """Import rules from a JSON array."""
    imported = 0
    errors: list[str] = []
    for rule_data in rules:
        try:
            rule = PhoenixRule(**rule_data.model_dump())
            await rule_store.insert_rule(rule.model_dump())
            imported += 1
        except Exception as e:
            errors.append(f"Rule '{rule_data.name}': {str(e)}")
    return {"imported": imported, "errors": errors}


@router.post("/rules/validate")
async def validate_rule(rule: RuleCreate):
    """Validate a rule without saving it."""
    # If we get here, Pydantic already validated the schema
    phoenix_rule = PhoenixRule(**rule.model_dump())
    return {"valid": True, "rule": phoenix_rule.model_dump()}


@router.get("/rules/{rule_id}")
async def get_rule(rule_id: str):
    """Get a single rule by ID."""
    rule = await rule_store.get_rule(rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    return rule


@router.post("/rules", status_code=201)
async def create_rule(rule: RuleCreate):
    """Create a new rule."""
    phoenix_rule = PhoenixRule(**rule.model_dump())
    created = await rule_store.insert_rule(phoenix_rule.model_dump())
    return created


@router.put("/rules/{rule_id}")
async def update_rule(rule_id: str, updates: RuleUpdate):
    """Update a rule's fields."""
    update_data = updates.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Serialize nested models to dicts for storage
    if "match" in update_data:
        update_data["match"] = updates.match.model_dump()
    if "actions" in update_data:
        update_data["actions"] = [a.model_dump() for a in updates.actions]

    updated = await rule_store.update_rule(rule_id, update_data)
    if updated is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    return updated


@router.delete("/rules/{rule_id}")
async def delete_rule(rule_id: str, hard: bool = Query(False)):
    """Delete a rule. Soft delete by default (sets enabled=false)."""
    deleted = await rule_store.delete_rule(rule_id, hard=hard)
    if not deleted:
        raise HTTPException(status_code=404, detail="Rule not found")
    return {"deleted": True, "hard": hard}


@router.post("/rules/{rule_id}/toggle")
async def toggle_rule(rule_id: str):
    """Toggle a rule's enabled/disabled state."""
    toggled = await rule_store.toggle_rule(rule_id)
    if toggled is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    return toggled


@router.post("/rules/{rule_id}/duplicate")
async def duplicate_rule(rule_id: str):
    """Clone a rule with a new ID."""
    existing = await rule_store.get_rule(rule_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Rule not found")

    new_rule = PhoenixRule(
        name=f"{existing['name']} (copy)",
        description=existing["description"],
        enabled=existing["enabled"],
        severity=existing["severity"],
        author=existing["author"],
        tags=existing["tags"],
        match=existing["match"],
        actions=existing["actions"],
        run_once_per_page=existing["run_once_per_page"],
        cooldown_ms=existing["cooldown_ms"],
        priority=existing["priority"],
    )
    created = await rule_store.insert_rule(new_rule.model_dump())
    return created
