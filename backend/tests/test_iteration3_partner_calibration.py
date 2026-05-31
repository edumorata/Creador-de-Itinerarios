"""Iteration 3 backend tests.

Covers:
  * GET /api/calibration/status   — admin-only, returns by_partner block.
  * GET /api/calibration/rules    — admin-only, returns 54 rules incl AR–AX.
  * GET /api/fx/rate              — any auth user, has base/quote/rate/source.
  * POST /api/ai/generate-itinerary — admin-only, 400 on missing client_request,
                                      accepts partner field.
  * Training examples — admin-only, partner field (default kimkim), 167 retro-
                        tagged docs, partner updatable via PATCH.
  * Admin-lock — 403 on calibration/* + training-examples/* + ai/* for agent.

Authenticates via the seeded admin and agent tokens described in
/app/memory/test_credentials.md. Does NOT call POST /api/calibration/run nor
generate-itinerary with real client_request (LLM budget).
"""
from __future__ import annotations

import os
from datetime import datetime, timezone, timedelta

import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL", "http://localhost:8001"
).rstrip("/")
API = f"{BASE_URL}/api"
ADMIN_TOKEN = "test_admin_session_token"
AGENT_TOKEN = "test_agent_session_token"

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


# ---- fixtures ---------------------------------------------------------------
@pytest.fixture(scope="session")
def db():
    return MongoClient(MONGO_URL)[DB_NAME]


def _seed_admin(db):
    db.users.delete_many({"email": "test.admin@example.com"})
    db.user_sessions.delete_many({"session_token": ADMIN_TOKEN})
    db.users.insert_one({
        "user_id": "test-user-admin",
        "email": "test.admin@example.com",
        "name": "Test Admin",
        "picture": None,
        "role": "admin",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    db.user_sessions.insert_one({
        "user_id": "test-user-admin",
        "session_token": ADMIN_TOKEN,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
        "created_at": datetime.now(timezone.utc),
    })


def _seed_agent(db):
    db.users.delete_many({"email": "test.agent@example.com"})
    db.user_sessions.delete_many({"session_token": AGENT_TOKEN})
    db.users.insert_one({
        "user_id": "test-user-agent",
        "email": "test.agent@example.com",
        "name": "Test Agent",
        "picture": None,
        "role": "agent",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    db.user_sessions.insert_one({
        "user_id": "test-user-agent",
        "session_token": AGENT_TOKEN,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
        "created_at": datetime.now(timezone.utc),
    })


@pytest.fixture(scope="session", autouse=True)
def seed(db):
    _seed_admin(db)
    _seed_agent(db)
    yield
    db.user_sessions.delete_many({"session_token": {"$in": [ADMIN_TOKEN, AGENT_TOKEN]}})
    db.users.delete_many({"email": {"$in": ["test.admin@example.com", "test.agent@example.com"]}})


@pytest.fixture()
def admin_client():
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {ADMIN_TOKEN}"})
    return s


@pytest.fixture()
def agent_client():
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {AGENT_TOKEN}"})
    return s


def _no_mongo_id(obj):
    if isinstance(obj, dict):
        assert "_id" not in obj, f"Mongo _id leaked in {obj}"
        for v in obj.values():
            _no_mongo_id(v)
    elif isinstance(obj, list):
        for v in obj:
            _no_mongo_id(v)


# ---- calibration ------------------------------------------------------------
class TestCalibrationStatus:
    def test_admin_returns_status_with_by_partner(self, admin_client):
        r = admin_client.get(f"{API}/calibration/status")
        assert r.status_code == 200, r.text
        body = r.json()
        _no_mongo_id(body)

        for k in (
            "trips_total_sold_with_request",
            "trips_analyzed",
            "trips_pending_eval",
            "eval_rows_on_disk",
            "global",
            "by_country",
            "by_sales_agent",
            "by_partner",
        ):
            assert k in body, f"missing key {k}"

        # by_partner shape: at least kimkim present
        assert "kimkim" in body["by_partner"]
        kim = body["by_partner"]["kimkim"]
        assert kim["n"] == 158
        # ratio ≈ 1.26, composition ≈ 0.64
        assert kim["median_ratio"] == pytest.approx(1.26, abs=0.05)
        assert kim["median_composition"] == pytest.approx(0.64, abs=0.05)

        # global block
        g = body["global"]
        for k in ("median_ratio", "mean_ratio", "median_composition", "mean_composition"):
            assert k in g

    def test_agent_gets_403(self, agent_client):
        r = agent_client.get(f"{API}/calibration/status")
        assert r.status_code == 403, r.text

    def test_no_token_gets_401(self):
        r = requests.get(f"{API}/calibration/status")
        assert r.status_code == 401


class TestCalibrationRules:
    def test_admin_returns_54_rules_with_ar_to_ax(self, admin_client):
        r = admin_client.get(f"{API}/calibration/rules")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["count"] == 54
        assert isinstance(body["rules"], list)
        keys = {x["key"] for x in body["rules"]}
        # New AR–AX rules required by this iteration
        for k in ("AR", "AS", "AT", "AU", "AV", "AW", "AX"):
            assert k in keys, f"missing rule {k}"
        # each rule has key/title/body
        for x in body["rules"]:
            assert x["key"]
            assert x["title"]
            assert "body" in x

    def test_agent_gets_403(self, agent_client):
        r = agent_client.get(f"{API}/calibration/rules")
        assert r.status_code == 403


class TestCalibrationRunConflict:
    """Do not actually launch the subprocess. Either expect 409 if one is
    already running, or skip cleanly if no row in calibration_jobs is in
    'running' state (we won't insert one to avoid mutating state)."""

    def test_calibration_run_does_not_start_extra(self, admin_client, db):
        running = db.calibration_jobs.find_one({"status": "running"})
        if not running:
            pytest.skip("no running job exists; would actually launch the subprocess")
        r = admin_client.post(f"{API}/calibration/run", json={})
        assert r.status_code == 409, r.text

    def test_calibration_run_agent_403(self, agent_client):
        # Hits permission gate before launching anything
        r = agent_client.post(f"{API}/calibration/run", json={})
        assert r.status_code == 403


# ---- FX rate ----------------------------------------------------------------
class TestFxRate:
    def test_fx_rate_admin(self, admin_client):
        r = admin_client.get(f"{API}/fx/rate", params={"base": "EUR", "quote": "USD"})
        assert r.status_code == 200, r.text
        body = r.json()
        _no_mongo_id(body)
        assert body["base"] == "EUR"
        assert body["quote"] == "USD"
        assert isinstance(body["rate"], (int, float))
        assert body["rate"] > 0
        assert body["source"] in ("cache", "fresh", "stale", "fallback")

    def test_fx_rate_agent_allowed(self, agent_client):
        """Per spec: any authenticated user can call /fx/rate."""
        r = agent_client.get(f"{API}/fx/rate", params={"base": "EUR", "quote": "USD"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["base"] == "EUR"
        assert body["rate"] > 0

    def test_fx_rate_no_token_401(self):
        r = requests.get(f"{API}/fx/rate", params={"base": "EUR", "quote": "USD"})
        assert r.status_code == 401


# ---- AI generate ------------------------------------------------------------
class TestAIGenerate:
    def test_400_on_missing_client_request(self, admin_client):
        r = admin_client.post(f"{API}/ai/generate-itinerary", json={})
        assert r.status_code == 400, r.text
        # also empty string -> 400
        r = admin_client.post(f"{API}/ai/generate-itinerary", json={"client_request": "   "})
        assert r.status_code == 400

    def test_agent_gets_403(self, agent_client):
        r = agent_client.post(
            f"{API}/ai/generate-itinerary",
            json={"client_request": "Trip to Lisbon", "partner": "kimkim", "save": False},
        )
        assert r.status_code == 403

    def test_agent_blocked_on_retrieval_stats(self, agent_client):
        r = agent_client.get(f"{API}/ai/retrieval/stats")
        assert r.status_code == 403


# ---- training examples ------------------------------------------------------
class TestTrainingExamplesList:
    def test_admin_lists_167_all_partner_kimkim(self, admin_client):
        r = admin_client.get(f"{API}/training-examples")
        assert r.status_code == 200, r.text
        items = r.json()
        assert isinstance(items, list)
        assert len(items) == 167
        # every doc must have partner='kimkim' after retro-tag
        wrong = [i for i in items if i.get("partner") != "kimkim"]
        assert wrong == [], f"{len(wrong)} docs not tagged kimkim"
        # no mongo _id
        _no_mongo_id(items)

    def test_agent_gets_403(self, agent_client):
        r = agent_client.get(f"{API}/training-examples")
        assert r.status_code == 403


class TestTrainingExampleCreatePatchDelete:
    def test_create_default_partner_kimkim(self, admin_client, db):
        r = admin_client.post(
            f"{API}/training-examples",
            json={
                "client_name": "TEST_t3_client",
                "client_request": "TEST_t3_request body",
                "outcome": "pending",
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        _no_mongo_id(body)
        assert body["partner"] == "kimkim"
        assert body["client_request"] == "TEST_t3_request body"
        eid = body["example_id"]
        try:
            # PATCH partner -> zicasso, verify persisted
            r = admin_client.patch(
                f"{API}/training-examples/{eid}",
                json={"partner": "zicasso"},
            )
            assert r.status_code == 200, r.text
            patched = r.json()
            assert patched["partner"] == "zicasso"

            # GET via list and confirm persistence
            lst = admin_client.get(f"{API}/training-examples").json()
            found = next((x for x in lst if x["example_id"] == eid), None)
            assert found is not None
            assert found["partner"] == "zicasso"
        finally:
            # cleanup
            r = admin_client.delete(f"{API}/training-examples/{eid}")
            assert r.status_code == 200

    def test_create_400_on_missing_client_request(self, admin_client):
        r = admin_client.post(
            f"{API}/training-examples",
            json={"client_name": "TEST_t3_no_req"},
        )
        assert r.status_code == 400

    def test_create_with_explicit_partner(self, admin_client):
        r = admin_client.post(
            f"{API}/training-examples",
            json={
                "client_name": "TEST_t3_partner_explicit",
                "client_request": "trip",
                "partner": "responsible_travel",
            },
        )
        assert r.status_code == 200
        eid = r.json()["example_id"]
        try:
            assert r.json()["partner"] == "responsible_travel"
        finally:
            admin_client.delete(f"{API}/training-examples/{eid}")

    def test_agent_blocked_on_create(self, agent_client):
        r = agent_client.post(
            f"{API}/training-examples",
            json={"client_name": "x", "client_request": "y"},
        )
        assert r.status_code == 403


# ---- broad admin-lock smoke -------------------------------------------------
class TestAdminLockSmoke:
    """Quick smoke that an agent-role user hits 403 on every iter-3 surface."""

    @pytest.mark.parametrize("method,path,payload", [
        ("GET", "/calibration/status", None),
        ("GET", "/calibration/rules", None),
        ("POST", "/calibration/run", {}),
        ("GET", "/training-examples", None),
        ("GET", "/training-examples/pending-request", None),
        ("POST", "/training-examples", {"client_request": "x"}),
        ("GET", "/ai/retrieval/stats", None),
        ("POST", "/ai/retrieval/search", {"query": "x"}),
        ("POST", "/ai/generate-itinerary", {"client_request": "x"}),
    ])
    def test_agent_403(self, agent_client, method, path, payload):
        url = f"{API}{path}"
        if method == "GET":
            r = agent_client.get(url)
        else:
            r = agent_client.post(url, json=payload)
        assert r.status_code == 403, f"{method} {path} -> {r.status_code}: {r.text}"
