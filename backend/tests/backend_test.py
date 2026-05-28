"""Backend integration tests for the Travel Itinerary Builder.

Covers: health, auth (me/logout), admin whitelist + RBAC, providers CRUD,
experiences CRUD + cascade + facets, itineraries CRUD, Excel export and
bulk provider-sheet import.

All tests authenticate via the seeded session token described in
/app/memory/test_credentials.md (Bearer test_admin_session_token).
"""
from __future__ import annotations

import io
import os
import subprocess
from datetime import datetime, timezone, timedelta

import openpyxl
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://itinerary-builder-74.preview.emergentagent.com").rstrip("/")
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
    # cleanup test data (keeps imported sample data)
    db.user_sessions.delete_many({"session_token": {"$in": [ADMIN_TOKEN, AGENT_TOKEN]}})
    db.users.delete_many({"email": {"$in": ["test.admin@example.com", "test.agent@example.com"]}})
    db.allowed_emails.delete_many({"email": {"$in": ["test.admin@example.com", "agent1@example.com"]}})


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


# ---- health -----------------------------------------------------------------
class TestHealth:
    def test_root_ok(self):
        r = requests.get(f"{API}/")
        assert r.status_code == 200
        assert r.json() == {"ok": True, "service": "itinerary-builder"}


# ---- auth -------------------------------------------------------------------
class TestAuth:
    def test_me_no_token_401(self):
        r = requests.get(f"{API}/auth/me")
        assert r.status_code == 401

    def test_me_with_bearer(self, admin_client):
        r = admin_client.get(f"{API}/auth/me")
        assert r.status_code == 200
        u = r.json()
        assert u["email"] == "test.admin@example.com"
        assert u["role"] == "admin"
        _no_mongo_id(u)

    def test_logout_revokes_then_reseed(self, db):
        # use a one-off token so we don't lose ADMIN_TOKEN for other tests
        token = "tmp_logout_token"
        db.user_sessions.insert_one({
            "user_id": "test-user-admin",
            "session_token": token,
            "expires_at": datetime.now(timezone.utc) + timedelta(days=1),
            "created_at": datetime.now(timezone.utc),
        })
        h = {"Authorization": f"Bearer {token}"}
        assert requests.get(f"{API}/auth/me", headers=h).status_code == 200
        r = requests.post(f"{API}/auth/logout", headers=h)
        assert r.status_code == 200
        assert requests.get(f"{API}/auth/me", headers=h).status_code == 401

    def test_admin_endpoint_denies_agent(self, agent_client):
        r = agent_client.get(f"{API}/admin/allowed-emails")
        assert r.status_code == 403


# ---- whitelist --------------------------------------------------------------
class TestWhitelist:
    def test_whitelist_crud(self, admin_client, db):
        db.allowed_emails.delete_many({"email": "agent1@example.com"})
        r = admin_client.post(f"{API}/admin/allowed-emails",
                              json={"email": "agent1@example.com", "role": "agent"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["email"] == "agent1@example.com"
        assert body["role"] == "agent"
        _no_mongo_id(body)

        r = admin_client.get(f"{API}/admin/allowed-emails")
        assert r.status_code == 200
        emails = [a["email"] for a in r.json()]
        assert "agent1@example.com" in emails

        r = admin_client.delete(f"{API}/admin/allowed-emails/agent1@example.com")
        assert r.status_code == 200

        r = admin_client.get(f"{API}/admin/allowed-emails")
        assert "agent1@example.com" not in [a["email"] for a in r.json()]


# ---- providers --------------------------------------------------------------
@pytest.fixture()
def created_provider(admin_client):
    r = admin_client.post(f"{API}/providers",
                          json={"name": "TEST_Provider_A", "country": "Italia"})
    assert r.status_code == 200, r.text
    return r.json()


class TestProviders:
    def test_provider_crud_and_sort(self, admin_client, created_provider):
        pid = created_provider["provider_id"]
        assert pid.startswith("prov_")
        _no_mongo_id(created_provider)

        # patch name
        r = admin_client.patch(f"{API}/providers/{pid}", json={"name": "TEST_Provider_A2"})
        assert r.status_code == 200
        assert r.json()["name"] == "TEST_Provider_A2"

        # list sorted
        r = admin_client.get(f"{API}/providers")
        assert r.status_code == 200
        names = [p["name"] for p in r.json()]
        assert names == sorted(names)

        # delete
        r = admin_client.delete(f"{API}/providers/{pid}")
        assert r.status_code == 200
        r = admin_client.delete(f"{API}/providers/{pid}")
        assert r.status_code == 404


# ---- experiences ------------------------------------------------------------
class TestExperiences:
    def test_experience_requires_existing_provider(self, admin_client):
        r = admin_client.post(f"{API}/experiences", json={
            "title": "Bad",
            "provider_id": "prov_does_not_exist",
            "price": 10,
        })
        assert r.status_code == 400

    def test_experience_full_flow_and_cascade(self, admin_client):
        # create two providers
        p1 = admin_client.post(f"{API}/providers", json={"name": "TEST_ProvX"}).json()
        p2 = admin_client.post(f"{API}/providers", json={"name": "TEST_ProvY"}).json()

        # create experience under p1
        r = admin_client.post(f"{API}/experiences", json={
            "title": "TEST_Exp_Tour",
            "description": "desc",
            "provider_id": p1["provider_id"],
            "country": "Italia",
            "city": "Rome",
            "type": "actividad",
            "price": 99.5,
        })
        assert r.status_code == 200, r.text
        exp = r.json()
        assert exp["provider_name"] == "TEST_ProvX"
        eid = exp["experience_id"]
        assert eid.startswith("exp_")
        _no_mongo_id(exp)

        # patch -> change provider re-denormalizes name
        r = admin_client.patch(f"{API}/experiences/{eid}",
                               json={"provider_id": p2["provider_id"]})
        assert r.status_code == 200
        assert r.json()["provider_name"] == "TEST_ProvY"

        # rename provider -> cascade
        admin_client.patch(f"{API}/providers/{p2['provider_id']}",
                           json={"name": "TEST_ProvY_renamed"})
        r = admin_client.get(f"{API}/experiences", params={"q": "TEST_Exp_Tour"})
        assert r.status_code == 200
        items = r.json()
        match = [i for i in items if i["experience_id"] == eid]
        assert match and match[0]["provider_name"] == "TEST_ProvY_renamed"

        # filters
        r = admin_client.get(f"{API}/experiences", params={"country": "Italia"})
        assert r.status_code == 200
        assert all(i["country"] == "Italia" for i in r.json())

        r = admin_client.get(f"{API}/experiences", params={"type": "actividad"})
        assert r.status_code == 200
        assert all(i["type"] == "actividad" for i in r.json())

        # facets
        r = admin_client.get(f"{API}/experiences/facets")
        assert r.status_code == 200
        f = r.json()
        for k in ("countries", "cities", "types"):
            assert k in f and isinstance(f[k], list)
        assert "Italia" in f["countries"]

        # cleanup
        admin_client.delete(f"{API}/experiences/{eid}")
        admin_client.delete(f"{API}/providers/{p1['provider_id']}")
        admin_client.delete(f"{API}/providers/{p2['provider_id']}")


# ---- itineraries + export ---------------------------------------------------
class TestItineraryAndExport:
    def test_itinerary_crud_and_excel_export(self, admin_client):
        # create
        r = admin_client.post(f"{API}/itineraries", json={
            "name": "TEST_Trip",
            "main_traveler": "John Doe",
            "start_date": "2026-04-01",
            "end_date": "2026-04-05",
            "duration_days": 4,
            "num_travelers": 2,
            "markup_pct": 20.0,
        })
        assert r.status_code == 200, r.text
        itn = r.json()
        iid = itn["itinerary_id"]
        assert iid.startswith("itn_")
        _no_mongo_id(itn)

        # get single
        r = admin_client.get(f"{API}/itineraries/{iid}")
        assert r.status_code == 200

        # patch -> add a day with one service priced 100, qty 2 -> subtotal 200
        r = admin_client.patch(f"{API}/itineraries/{iid}", json={
            "days": [{
                "label": "Day 1",
                "date": "2026-04-01",
                "services": [{
                    "type": "actividad",
                    "name": "Colosseum Tour",
                    "quantity": 2,
                    "unit_price": 100,
                    "currency": "EUR",
                }],
            }],
        })
        assert r.status_code == 200
        assert len(r.json()["days"]) == 1

        # export
        r = admin_client.get(f"{API}/itineraries/{iid}/export")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        assert len(r.content) > 1000

        wb = openpyxl.load_workbook(io.BytesIO(r.content))
        ws = wb.active
        assert ws.title == "Trip Prices"
        # main traveler in B1
        assert ws.cell(1, 2).value == "John Doe"
        # Day 1 header somewhere in column A under activities section
        col_a = [ws.cell(row, 1).value for row in range(1, ws.max_row + 1)]
        assert "Day 1" in col_a
        # service row should appear with Name + Price
        all_cells = [(ws.cell(r, c).value) for r in range(1, ws.max_row + 1) for c in range(1, 8)]
        assert "Colosseum Tour" in all_cells
        # Final price = subtotal * (1 + markup/100) = 200 * 1.2 = 240
        # find "Final price" label row
        final_row = None
        for row in range(1, ws.max_row + 1):
            if ws.cell(row, 4).value == "Final price":
                final_row = row
                break
        assert final_row is not None, "Final price row missing"
        assert ws.cell(final_row, 7).value == pytest.approx(240.0)

        # delete
        r = admin_client.delete(f"{API}/itineraries/{iid}")
        assert r.status_code == 200
        assert admin_client.get(f"{API}/itineraries/{iid}").status_code == 404


# ---- stats ------------------------------------------------------------------
class TestStats:
    def test_stats(self, admin_client):
        r = admin_client.get(f"{API}/stats")
        assert r.status_code == 200
        data = r.json()
        for k in ("providers", "experiences", "itineraries", "users"):
            assert k in data
            assert isinstance(data[k], int)


# ---- bulk import ------------------------------------------------------------
class TestBulkImport:
    def test_import_synthetic_xlsx(self, admin_client, db):
        # generate xlsx in-memory
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(["operator_name", "name", "price_tax_incl", "currency"])
        ws.append(["TEST_BulkProvider", "TEST_BulkExp_1", 50, "EUR"])
        ws.append(["TEST_BulkProvider", "TEST_BulkExp_2", 75, "EUR"])
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        files = {"file": ("synth.xlsx", buf,
                          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
        r = admin_client.post(
            f"{API}/experiences/import-provider-sheet",
            params={"country": "Italia", "city": "Rome", "type": "actividad"},
            files=files,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["created"] == 2
        assert body["providers"] == 1

        # provider created once
        prov_count = db.providers.count_documents({"name": "TEST_BulkProvider"})
        assert prov_count == 1

        # cleanup
        prov = db.providers.find_one({"name": "TEST_BulkProvider"})
        if prov:
            db.experiences.delete_many({"provider_id": prov["provider_id"]})
            db.providers.delete_one({"provider_id": prov["provider_id"]})

    def test_import_real_provider_sheet(self, admin_client, db):
        path = "/app/artifacts/excel_creados/1. EXCEL CREADOS/3. ITALIA/Roman Road Tours_2024.xlsx"
        if not os.path.exists(path):
            pytest.skip("sample xlsx missing")
        # clear any prior imports of this provider so the test is repeatable
        existing = list(db.providers.find({"name": {"$regex": "Roman Road", "$options": "i"}}))
        for p in existing:
            db.experiences.delete_many({"provider_id": p["provider_id"]})
            db.providers.delete_one({"provider_id": p["provider_id"]})

        with open(path, "rb") as f:
            files = {"file": (os.path.basename(path), f,
                              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
            r = admin_client.post(
                f"{API}/experiences/import-provider-sheet",
                params={"country": "Italia", "city": "Rome", "type": "actividad"},
                files=files,
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["created"] >= 1
        assert body["providers"] >= 1
