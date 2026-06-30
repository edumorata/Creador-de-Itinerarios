"""Backend tests for iteration 19 — share itinerary + pax breakdown.

Covers:
  - GET /api/agents/list (filter self, sorted, enriched)
  - POST/DELETE /api/itineraries/{id}/share (whitelist, idempotent, errors)
  - GET /api/itineraries scoping for non-admin (owner OR shared_with)
  - PATCH /api/itineraries/{id} persistence of num_adults/num_children/children_ages
  - _can_access gating via PATCH from a shared user session

Uses the live preview URL via REACT_APP_BACKEND_URL.
"""
import os
import uuid
import pytest
import requests
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
from pymongo import MongoClient

# Load backend .env for direct Mongo access (creating ad-hoc sessions for non-admin tests).
load_dotenv("/app/backend/.env")
load_dotenv("/app/frontend/.env")

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
ADMIN_TOKEN = os.environ["TEST_ADMIN_TOKEN"]
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
ITN_ID = "itn_708e44718bc6"  # Pepe Perez Tour (owned by eduardo)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def admin_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    s.cookies.set("session_token", ADMIN_TOKEN)
    return s


@pytest.fixture(scope="module")
def mongo():
    cli = MongoClient(MONGO_URL)
    yield cli[DB_NAME]
    cli.close()


@pytest.fixture(scope="module")
def marina_session(mongo):
    """Create a temporary user + session for marina to exercise non-admin gating.
    Cleaned up after the module finishes."""
    email = "marina@viajadverdad.com"
    # Ensure a users row exists with role=agent (it might not exist yet).
    mongo.users.update_one(
        {"email": email},
        {"$setOnInsert": {
            "user_id": "u_marina_test",
            "email": email,
            "name": "Marina (test)",
            "role": "agent",
        }},
        upsert=True,
    )
    token = uuid.uuid4().hex
    expires = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    mongo.user_sessions.insert_one({
        "session_token": token,
        "user_id": "u_marina_test",
        "email": email,
        "expires_at": expires,
    })
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    s.cookies.set("session_token", token)
    yield {"session": s, "email": email, "token": token}
    # Teardown
    mongo.user_sessions.delete_one({"session_token": token})


@pytest.fixture(scope="module")
def test_admin_session(mongo):
    """Create a user + session for test.admin@example.com (admin role)
    so we can verify the 'shared with marina' GET /itineraries scoping rule."""
    email = "test.admin@example.com"
    mongo.users.update_one(
        {"email": email},
        {"$setOnInsert": {
            "user_id": "u_testadmin",
            "email": email,
            "name": "Test Admin",
            "role": "admin",
        }},
        upsert=True,
    )
    # Make sure they ARE allowed_emails too, in case sharing logic ever depends on it.
    token = uuid.uuid4().hex
    expires = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    mongo.user_sessions.insert_one({
        "session_token": token,
        "user_id": "u_testadmin",
        "email": email,
        "expires_at": expires,
    })
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    s.cookies.set("session_token", token)
    yield {"session": s, "email": email, "token": token}
    mongo.user_sessions.delete_one({"session_token": token})


# ---------------------------------------------------------------------------
# GET /agents/list
# ---------------------------------------------------------------------------
class TestAgentsList:
    def test_excludes_self_and_sorted(self, admin_client):
        r = admin_client.get(f"{BASE_URL}/api/agents/list")
        assert r.status_code == 200, r.text
        data = r.json()
        assert "agents" in data
        agents = data["agents"]
        emails = [a["email"] for a in agents]
        # Self excluded
        assert "eduardo@viajadverdad.com" not in emails
        # 9 remaining (10 allowed - eduardo)
        assert len(agents) == 9, f"expected 9, got {len(agents)}: {emails}"
        # Required fields
        for a in agents:
            assert {"email", "name", "role"} <= set(a.keys())
        # Sorted by name (case-insensitive)
        names = [a["name"].lower() for a in agents]
        assert names == sorted(names), f"not sorted: {names}"

    def test_no_session_unauth(self):
        r = requests.get(f"{BASE_URL}/api/agents/list")
        assert r.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Share / Unshare
# ---------------------------------------------------------------------------
class TestShareItinerary:
    def _reset_shared(self, mongo, itn_id):
        mongo.itineraries.update_one({"itinerary_id": itn_id}, {"$set": {"shared_with": []}})

    def test_share_with_marina_success_and_idempotent(self, admin_client, mongo):
        self._reset_shared(mongo, ITN_ID)
        r1 = admin_client.post(
            f"{BASE_URL}/api/itineraries/{ITN_ID}/share",
            json={"email": "marina@viajadverdad.com"},
        )
        assert r1.status_code == 200, r1.text
        d1 = r1.json()
        assert d1["ok"] is True
        assert d1["shared_with"] == ["marina@viajadverdad.com"]
        # GET to verify persistence
        g = admin_client.get(f"{BASE_URL}/api/itineraries/{ITN_ID}")
        assert g.status_code == 200
        assert "marina@viajadverdad.com" in g.json()["shared_with"]
        # Idempotent
        r2 = admin_client.post(
            f"{BASE_URL}/api/itineraries/{ITN_ID}/share",
            json={"email": "marina@viajadverdad.com"},
        )
        assert r2.status_code == 200
        assert r2.json()["shared_with"] == ["marina@viajadverdad.com"]

    def test_share_with_unknown_email_400(self, admin_client):
        r = admin_client.post(
            f"{BASE_URL}/api/itineraries/{ITN_ID}/share",
            json={"email": "stranger@nowhere.com"},
        )
        assert r.status_code == 400
        body = r.json()
        msg = body.get("detail") or body.get("message") or ""
        assert "agentes autorizados" in msg

    def test_share_with_self_400(self, admin_client):
        r = admin_client.post(
            f"{BASE_URL}/api/itineraries/{ITN_ID}/share",
            json={"email": "eduardo@viajadverdad.com"},
        )
        assert r.status_code == 400

    def test_share_unknown_itinerary_404(self, admin_client):
        r = admin_client.post(
            f"{BASE_URL}/api/itineraries/itn_doesnotexist/share",
            json={"email": "marina@viajadverdad.com"},
        )
        assert r.status_code == 404

    def test_share_without_session_unauth(self):
        r = requests.post(
            f"{BASE_URL}/api/itineraries/{ITN_ID}/share",
            json={"email": "marina@viajadverdad.com"},
        )
        assert r.status_code in (401, 403)

    def test_unshare_owner_can_remove(self, admin_client, mongo):
        # Ensure marina is currently shared.
        admin_client.post(
            f"{BASE_URL}/api/itineraries/{ITN_ID}/share",
            json={"email": "marina@viajadverdad.com"},
        )
        r = admin_client.delete(
            f"{BASE_URL}/api/itineraries/{ITN_ID}/share/marina@viajadverdad.com"
        )
        assert r.status_code == 200
        assert "marina@viajadverdad.com" not in r.json()["shared_with"]

    def test_collaborator_can_self_unshare(self, admin_client, marina_session, mongo):
        # Share marina via owner
        admin_client.post(
            f"{BASE_URL}/api/itineraries/{ITN_ID}/share",
            json={"email": "marina@viajadverdad.com"},
        )
        # Marina removes herself
        r = marina_session["session"].delete(
            f"{BASE_URL}/api/itineraries/{ITN_ID}/share/marina@viajadverdad.com"
        )
        assert r.status_code == 200
        assert "marina@viajadverdad.com" not in r.json()["shared_with"]

    def test_third_party_cannot_unshare_other(self, admin_client, marina_session):
        # Share rita; marina (unrelated) tries to remove rita
        admin_client.post(
            f"{BASE_URL}/api/itineraries/{ITN_ID}/share",
            json={"email": "rita@viajadverdad.com"},
        )
        r = marina_session["session"].delete(
            f"{BASE_URL}/api/itineraries/{ITN_ID}/share/rita@viajadverdad.com"
        )
        assert r.status_code == 403
        # cleanup
        admin_client.delete(
            f"{BASE_URL}/api/itineraries/{ITN_ID}/share/rita@viajadverdad.com"
        )


# ---------------------------------------------------------------------------
# GET /itineraries scoping
# ---------------------------------------------------------------------------
class TestListScoping:
    def test_admin_sees_all(self, admin_client):
        r = admin_client.get(f"{BASE_URL}/api/itineraries")
        assert r.status_code == 200
        items = r.json()
        assert len(items) >= 10, f"admin should see all; got {len(items)}"

    def test_non_admin_sees_only_own_plus_shared(
        self, admin_client, marina_session, mongo
    ):
        # marina has no itineraries of her own. Share ITN_ID with marina.
        admin_client.post(
            f"{BASE_URL}/api/itineraries/{ITN_ID}/share",
            json={"email": "marina@viajadverdad.com"},
        )
        r = marina_session["session"].get(f"{BASE_URL}/api/itineraries")
        assert r.status_code == 200
        items = r.json()
        ids = [i["itinerary_id"] for i in items]
        # Marina must see ITN_ID (because it was shared).
        assert ITN_ID in ids
        # And nothing else NOT owned/shared. Since she owns none, the only
        # itineraries should be those where she is in shared_with.
        for it in items:
            assert (
                it.get("created_by") == marina_session["email"]
                or marina_session["email"] in (it.get("shared_with") or [])
            ), f"leak: {it.get('itinerary_id')} created_by={it.get('created_by')}"
        # cleanup
        admin_client.delete(
            f"{BASE_URL}/api/itineraries/{ITN_ID}/share/marina@viajadverdad.com"
        )


# ---------------------------------------------------------------------------
# PATCH pax fields + shared user write
# ---------------------------------------------------------------------------
class TestPaxFields:
    def test_patch_pax_breakdown_persists(self, admin_client):
        # Save original to restore.
        g0 = admin_client.get(f"{BASE_URL}/api/itineraries/{ITN_ID}").json()
        original = {
            "num_adults": g0.get("num_adults"),
            "num_children": g0.get("num_children", 0),
            "children_ages": g0.get("children_ages", []),
        }
        try:
            patch = {"num_adults": 3, "num_children": 2, "children_ages": [5, 8]}
            r = admin_client.patch(
                f"{BASE_URL}/api/itineraries/{ITN_ID}", json=patch
            )
            assert r.status_code == 200, r.text
            d = r.json()
            assert d["num_adults"] == 3
            assert d["num_children"] == 2
            assert d["children_ages"] == [5, 8]
            # GET re-verify
            g = admin_client.get(f"{BASE_URL}/api/itineraries/{ITN_ID}").json()
            assert g["num_adults"] == 3
            assert g["num_children"] == 2
            assert g["children_ages"] == [5, 8]
        finally:
            admin_client.patch(f"{BASE_URL}/api/itineraries/{ITN_ID}", json=original)

    def test_shared_user_can_patch(self, admin_client, marina_session):
        admin_client.post(
            f"{BASE_URL}/api/itineraries/{ITN_ID}/share",
            json={"email": "marina@viajadverdad.com"},
        )
        try:
            r = marina_session["session"].patch(
                f"{BASE_URL}/api/itineraries/{ITN_ID}",
                json={"num_adults": 4},
            )
            assert r.status_code == 200, r.text
            assert r.json()["num_adults"] == 4
        finally:
            admin_client.delete(
                f"{BASE_URL}/api/itineraries/{ITN_ID}/share/marina@viajadverdad.com"
            )

    def test_non_shared_non_owner_cannot_patch(self, marina_session):
        # Marina is NOT shared on this point.
        r = marina_session["session"].patch(
            f"{BASE_URL}/api/itineraries/{ITN_ID}", json={"num_adults": 9}
        )
        assert r.status_code == 403
