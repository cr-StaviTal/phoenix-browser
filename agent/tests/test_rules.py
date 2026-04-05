"""Tests for rules CRUD API."""
import pytest


def make_rule(name="Test Rule", **overrides):
    """Build a valid rule creation payload."""
    rule = {
        "name": name,
        "description": "Test rule description",
        "severity": "medium",
        "match": {
            "domains": ["*.example.com"],
            "trigger": {"type": "page_load"},
            "dom_conditions": [
                {"type": "element_exists", "selector": "iframe"}
            ],
        },
        "actions": [
            {"type": "hide_element", "params": {"selector": "iframe"}}
        ],
    }
    rule.update(overrides)
    return rule


class TestCreateRule:
    async def test_create_rule_returns_201(self, client):
        resp = await client.post("/api/rules", json=make_rule())
        assert resp.status_code == 201

    async def test_created_rule_has_id(self, client):
        resp = await client.post("/api/rules", json=make_rule())
        data = resp.json()
        assert "id" in data
        assert len(data["id"]) > 0

    async def test_created_rule_has_version_1(self, client):
        resp = await client.post("/api/rules", json=make_rule())
        assert resp.json()["version"] == 1

    async def test_created_rule_has_timestamps(self, client):
        resp = await client.post("/api/rules", json=make_rule())
        data = resp.json()
        assert "created_at" in data
        assert "updated_at" in data

    async def test_create_rule_missing_name_returns_422(self, client):
        rule = make_rule()
        del rule["name"]
        resp = await client.post("/api/rules", json=rule)
        assert resp.status_code == 422

    async def test_create_rule_missing_match_returns_422(self, client):
        rule = make_rule()
        del rule["match"]
        resp = await client.post("/api/rules", json=rule)
        assert resp.status_code == 422


class TestListRules:
    async def test_list_empty(self, client):
        resp = await client.get("/api/rules")
        assert resp.status_code == 200
        assert resp.json()["rules"] == []
        assert resp.json()["total"] == 0

    async def test_list_after_create(self, client):
        await client.post("/api/rules", json=make_rule("Rule 1"))
        await client.post("/api/rules", json=make_rule("Rule 2"))
        resp = await client.get("/api/rules")
        assert resp.json()["total"] == 2

    async def test_list_enabled_only(self, client):
        await client.post("/api/rules", json=make_rule("Enabled", enabled=True))
        await client.post("/api/rules", json=make_rule("Disabled", enabled=False))
        resp = await client.get("/api/rules?enabled=true")
        assert resp.json()["total"] == 1
        assert resp.json()["rules"][0]["name"] == "Enabled"

    async def test_list_ordered_by_priority(self, client):
        await client.post("/api/rules", json=make_rule("Low", priority=10))
        await client.post("/api/rules", json=make_rule("High", priority=200))
        resp = await client.get("/api/rules")
        rules = resp.json()["rules"]
        assert rules[0]["name"] == "High"
        assert rules[1]["name"] == "Low"


class TestGetRule:
    async def test_get_existing_rule(self, client):
        create_resp = await client.post("/api/rules", json=make_rule())
        rule_id = create_resp.json()["id"]
        resp = await client.get(f"/api/rules/{rule_id}")
        assert resp.status_code == 200
        assert resp.json()["id"] == rule_id

    async def test_get_nonexistent_returns_404(self, client):
        resp = await client.get("/api/rules/nonexistent-id")
        assert resp.status_code == 404


class TestUpdateRule:
    async def test_update_name(self, client):
        create_resp = await client.post("/api/rules", json=make_rule("Original"))
        rule_id = create_resp.json()["id"]
        resp = await client.put(f"/api/rules/{rule_id}", json={"name": "Updated"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "Updated"

    async def test_update_bumps_version(self, client):
        create_resp = await client.post("/api/rules", json=make_rule())
        rule_id = create_resp.json()["id"]
        resp = await client.put(f"/api/rules/{rule_id}", json={"name": "V2"})
        assert resp.json()["version"] == 2

    async def test_update_nonexistent_returns_404(self, client):
        resp = await client.put("/api/rules/nonexistent-id", json={"name": "X"})
        assert resp.status_code == 404


class TestDeleteRule:
    async def test_soft_delete(self, client):
        create_resp = await client.post("/api/rules", json=make_rule())
        rule_id = create_resp.json()["id"]
        resp = await client.delete(f"/api/rules/{rule_id}")
        assert resp.status_code == 200
        # Rule still exists (soft delete) but enabled is set to False
        get_resp = await client.get(f"/api/rules/{rule_id}")
        assert get_resp.status_code == 200
        assert get_resp.json()["enabled"] is False

    async def test_hard_delete(self, client):
        create_resp = await client.post("/api/rules", json=make_rule())
        rule_id = create_resp.json()["id"]
        resp = await client.delete(f"/api/rules/{rule_id}?hard=true")
        assert resp.status_code == 200
        get_resp = await client.get(f"/api/rules/{rule_id}")
        assert get_resp.status_code == 404


class TestToggleRule:
    async def test_toggle_disables_enabled_rule(self, client):
        create_resp = await client.post("/api/rules", json=make_rule(enabled=True))
        rule_id = create_resp.json()["id"]
        resp = await client.post(f"/api/rules/{rule_id}/toggle")
        assert resp.json()["enabled"] is False

    async def test_toggle_enables_disabled_rule(self, client):
        create_resp = await client.post("/api/rules", json=make_rule(enabled=False))
        rule_id = create_resp.json()["id"]
        resp = await client.post(f"/api/rules/{rule_id}/toggle")
        assert resp.json()["enabled"] is True


class TestDuplicateRule:
    async def test_duplicate_creates_new_rule(self, client):
        create_resp = await client.post("/api/rules", json=make_rule("Original"))
        rule_id = create_resp.json()["id"]
        resp = await client.post(f"/api/rules/{rule_id}/duplicate")
        assert resp.status_code == 200
        assert resp.json()["id"] != rule_id


class TestValidateRule:
    async def test_validate_valid_rule(self, client):
        resp = await client.post("/api/rules/validate", json=make_rule())
        assert resp.status_code == 200
        assert resp.json()["valid"] is True

    async def test_validate_invalid_rule(self, client):
        # Missing required 'match' field — Pydantic returns 422 Unprocessable Entity
        resp = await client.post("/api/rules/validate", json={"name": "No match"})
        assert resp.status_code == 422


class TestExportImport:
    async def test_export_rules(self, client):
        await client.post("/api/rules", json=make_rule("Rule 1"))
        await client.post("/api/rules", json=make_rule("Rule 2"))
        resp = await client.get("/api/rules/export")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2

    async def test_import_rules(self, client):
        rules = [make_rule("Import 1"), make_rule("Import 2")]
        resp = await client.post("/api/rules/import", json=rules)
        assert resp.status_code == 200
        assert resp.json()["imported"] == 2
        list_resp = await client.get("/api/rules")
        assert list_resp.json()["total"] == 2


class TestRuleDashboard:
    async def test_rules_page_returns_200(self, client):
        resp = await client.get("/dashboard/rules")
        assert resp.status_code == 200

    async def test_new_rule_page_returns_200(self, client):
        resp = await client.get("/dashboard/rules/new")
        assert resp.status_code == 200

    async def test_settings_page_returns_200(self, client):
        resp = await client.get("/dashboard/settings")
        assert resp.status_code == 200
