"""Backend tests for the 'flexible payments + traveler-info email' iteration.

Covers:
  - Initial-state options (deposit + full, no partial_bounds yet).
  - Post-deposit options (balance + partial, with partial_bounds + monthly_suggested_eur).
  - create-order with kind='partial' (happy + min/max/no-amount rejections).
  - create-order with kind='balance' / 'partial' before any payment is captured.
  - POST /payments/{token}/traveler-info (200, persists, idempotent last-write-wins,
    survives empty created_by gracefully).
"""
import os
import asyncio
import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://itinerary-builder-74.preview.emergentagent.com").rstrip("/")
TOKEN = "k5S26d0v3GASNZthPtBQe5rPeio"
ITN_ID = "itn_a7c0b99824a4"
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


# ---------- fixtures ----------

@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture
def clean_state():
    """Ensure the itinerary starts with no captured payments and no traveler_info."""
    async def _reset(payments=None, drop_traveler=True):
        client = AsyncIOMotorClient(MONGO_URL)
        db = client[DB_NAME]
        upd = {"$set": {"payments": payments or []}}
        if drop_traveler:
            upd["$unset"] = {"traveler_info": ""}
        await db.itineraries.update_one({"payment_token": TOKEN}, upd)
        client.close()
    asyncio.run(_reset())
    yield _reset
    asyncio.run(_reset())


@pytest.fixture
def with_captured_deposit():
    """Inject a fake captured deposit payment, then clean up."""
    async def _set(payments):
        client = AsyncIOMotorClient(MONGO_URL)
        db = client[DB_NAME]
        await db.itineraries.update_one(
            {"payment_token": TOKEN},
            {"$set": {"payments": payments}, "$unset": {"traveler_info": ""}},
        )
        client.close()
    fake = [{
        "payment_id": "pmt_test_deposit",
        "kind": "deposit",
        "amount_eur": 1290.54,
        "paypal_order_id": "F1",
        "paypal_capture_id": "C1",
        "status": "captured",
        "created_at": "2026-06-30T10:00:00Z",
        "paid_at": "2026-06-30T10:01:00Z",
        "paid_amount": 1290.54,
        "paid_currency": "EUR",
        "client_origin": BASE_URL,
    }]
    asyncio.run(_set(fake))
    yield
    asyncio.run(_set([]))


# ---------- Payment options ----------

class TestPaymentOptionsInitialState:
    def test_initial_state_offers_deposit_and_full(self, api, clean_state):
        r = api.get(f"{BASE_URL}/api/payments/{TOKEN}")
        assert r.status_code == 200, r.text
        d = r.json()
        kinds = [o["kind"] for o in d["options"]]
        assert "deposit" in kinds and "full" in kinds
        assert "partial" not in kinds and "balance" not in kinds
        assert d["partial_bounds"] is None
        assert d["monthly_suggested_eur"] is None
        assert d["paid_eur"] == 0.0
        # days_to_trip > 60 for this itinerary
        assert d["days_to_trip"] is None or d["days_to_trip"] > 60


class TestPaymentOptionsAfterDeposit:
    def test_after_deposit_offers_balance_and_partial(self, api, with_captured_deposit):
        r = api.get(f"{BASE_URL}/api/payments/{TOKEN}")
        assert r.status_code == 200, r.text
        d = r.json()
        kinds = [o["kind"] for o in d["options"]]
        assert "balance" in kinds
        assert "partial" in kinds
        # totals: 4301.81 total, 1290.54 paid → 3011.27 remaining
        assert d["paid_eur"] == pytest.approx(1290.54, abs=0.05)
        assert d["remaining_eur"] == pytest.approx(3011.27, abs=0.05)
        balance = next(o for o in d["options"] if o["kind"] == "balance")
        assert balance["amount_eur"] == pytest.approx(3011.27, abs=0.05)
        # partial_bounds
        pb = d["partial_bounds"]
        assert pb is not None
        assert pb["min_eur"] == pytest.approx(430.18, abs=0.05)  # 10% of 4301.81
        assert pb["max_eur"] == pytest.approx(3011.27, abs=0.05)
        # monthly suggestion
        ms = d["monthly_suggested_eur"]
        assert ms is not None
        for k in ("amount_eur", "months", "days_to_trip"):
            assert k in ms
        assert ms["amount_eur"] >= pb["min_eur"] - 0.01
        assert ms["amount_eur"] <= pb["max_eur"] + 0.01


# ---------- create-order kind=partial ----------

class TestCreateOrderPartial:
    def test_partial_happy_path(self, api, with_captured_deposit):
        # Pick a valid amount inside bounds (suggested monthly is safest).
        opts = api.get(f"{BASE_URL}/api/payments/{TOKEN}").json()
        amount = float(opts["monthly_suggested_eur"]["amount_eur"])
        r = api.post(f"{BASE_URL}/api/payments/{TOKEN}/create-order",
                     json={"kind": "partial", "amount_eur": amount})
        assert r.status_code == 200, r.text
        body = r.json()
        assert "approval_url" in body and body["approval_url"].startswith("https://")
        assert "paypal_order_id" in body

    def test_partial_below_min_rejected(self, api, with_captured_deposit):
        r = api.post(f"{BASE_URL}/api/payments/{TOKEN}/create-order",
                     json={"kind": "partial", "amount_eur": 50.0})
        assert r.status_code == 400, r.text
        assert "cantidad" in r.json().get("detail", "").lower()

    def test_partial_above_max_rejected(self, api, with_captured_deposit):
        # Above remaining (3011.27)
        r = api.post(f"{BASE_URL}/api/payments/{TOKEN}/create-order",
                     json={"kind": "partial", "amount_eur": 9999.99})
        assert r.status_code == 400, r.text

    def test_partial_no_amount_rejected(self, api, with_captured_deposit):
        r = api.post(f"{BASE_URL}/api/payments/{TOKEN}/create-order",
                     json={"kind": "partial"})
        assert r.status_code == 400, r.text
        assert "indica la cantidad" in r.json().get("detail", "").lower()


# ---------- create-order pre-deposit guards ----------

class TestCreateOrderGuards:
    def test_balance_before_any_capture_rejected(self, api, clean_state):
        r = api.post(f"{BASE_URL}/api/payments/{TOKEN}/create-order",
                     json={"kind": "balance"})
        assert r.status_code == 400, r.text

    def test_partial_before_any_capture_rejected(self, api, clean_state):
        r = api.post(f"{BASE_URL}/api/payments/{TOKEN}/create-order",
                     json={"kind": "partial", "amount_eur": 500.0})
        assert r.status_code == 400, r.text


# ---------- traveler-info ----------

class TestTravelerInfoEndpoint:
    def test_submit_returns_200_and_persists(self, api, clean_state):
        payload = {
            "people": [
                {"full_name": "TEST_Juan Perez", "passport_number": "X1234567", "date_of_birth": "1990-05-12"},
                {"full_name": "TEST_Ana Lopez", "passport_number": "Y7654321", "date_of_birth": "1992-08-22"},
            ],
            "arrival_flight": "IB6250",
            "departure_flight": "IB6251",
            "phone": "+34600111222",
            "notes": "Allergic to peanuts.",
            "submitted_by_email": "test_client@example.com",
        }
        r = api.post(f"{BASE_URL}/api/payments/{TOKEN}/traveler-info", json=payload)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True
        assert "submitted_at" in body and body["submitted_at"]

        # Verify persistence via Mongo
        async def _check():
            client = AsyncIOMotorClient(MONGO_URL)
            db = client[DB_NAME]
            doc = await db.itineraries.find_one({"payment_token": TOKEN}, {"_id": 0, "traveler_info": 1})
            client.close()
            return doc
        doc = asyncio.run(_check())
        ti = doc.get("traveler_info") or {}
        assert ti.get("phone") == "+34600111222"
        assert ti.get("arrival_flight") == "IB6250"
        assert len(ti.get("people") or []) == 2
        assert ti["people"][0]["full_name"] == "TEST_Juan Perez"

    def test_last_submit_wins(self, api, clean_state):
        # 1st submit
        api.post(f"{BASE_URL}/api/payments/{TOKEN}/traveler-info", json={
            "people": [{"full_name": "TEST_OLD", "passport_number": "A1", "date_of_birth": "2000-01-01"}],
            "arrival_flight": "OLD",
        })
        # 2nd submit with new data
        r = api.post(f"{BASE_URL}/api/payments/{TOKEN}/traveler-info", json={
            "people": [{"full_name": "TEST_NEW", "passport_number": "B2", "date_of_birth": "2001-02-02"}],
            "arrival_flight": "NEW",
            "phone": "+34999",
        })
        assert r.status_code == 200, r.text

        async def _check():
            client = AsyncIOMotorClient(MONGO_URL)
            db = client[DB_NAME]
            doc = await db.itineraries.find_one({"payment_token": TOKEN}, {"_id": 0, "traveler_info": 1})
            client.close()
            return doc
        ti = (asyncio.run(_check()) or {}).get("traveler_info") or {}
        assert ti.get("arrival_flight") == "NEW"
        assert len(ti.get("people") or []) == 1
        assert ti["people"][0]["full_name"] == "TEST_NEW"

    def test_unknown_token_returns_404(self, api):
        r = api.post(f"{BASE_URL}/api/payments/__bogus_token__/traveler-info",
                     json={"people": [], "arrival_flight": "x"})
        assert r.status_code == 404

    def test_empty_created_by_does_not_break(self, api):
        """Defensive — even if created_by is empty/missing on an itinerary,
        the form submission must still return 200 (email is fire-and-forget)."""
        # Use a temp itinerary scoped to this test only.
        async def _setup():
            client = AsyncIOMotorClient(MONGO_URL)
            db = client[DB_NAME]
            await db.itineraries.insert_one({
                "id": "itn_test_empty_creator",
                "payment_token": "tok_test_empty_creator",
                "name": "TEST_empty_creator_trip",
                "created_by": "",  # explicitly empty
                "start_date": "2026-12-01",
                "end_date": "2026-12-10",
            })
            client.close()

        async def _teardown():
            client = AsyncIOMotorClient(MONGO_URL)
            db = client[DB_NAME]
            await db.itineraries.delete_one({"id": "itn_test_empty_creator"})
            client.close()

        asyncio.run(_setup())
        try:
            r = api.post(f"{BASE_URL}/api/payments/tok_test_empty_creator/traveler-info",
                         json={"people": [], "arrival_flight": "x"})
            assert r.status_code == 200, r.text
        finally:
            asyncio.run(_teardown())
