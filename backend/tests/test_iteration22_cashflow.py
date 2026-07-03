"""Iteration 22 — Cashflow advanced backend tests.

Covers:
  1. Public /api/payments/{token} now returns `captured_payments[]`.
  2. Split-payment fields (payer_name/payer_email/share_label) accepted by
     POST /api/payments/{token}/create-order.
  3. Post-sale extras CRUD (POST/GET/DELETE /api/itineraries/{id}/extras).
  4. Public extra endpoints: GET /api/payments/extra/{token} and
     POST /api/payments/extra/{token}/create-order.
  5. Refund workflow: create + list + non-manager 403 on approve/reject +
     validation on refundable amount.
"""

import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://itinerary-builder-74.preview.emergentagent.com").rstrip("/")
SESSION_TOKEN = "3rrWWDXfC1ze9MEHqZzbC0eQK3nq29wClvsJPIMsQhc"

# Itinerary WITH captured deposit (Pepe Perez Tour)
ITN_PAID = "itn_708e44718bc6"
CAPTURED_PAYMENT_ID = "pmt_74fe6f6d51c8"

# Itinerary WITHOUT any captured payment (From Fashion to Canals)
ITN_CLEAN = "itn_c4457abd4cbe"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Cookie": f"session_token={SESSION_TOKEN}",
                      "Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def paid_token(client):
    r = client.get(f"{BASE_URL}/api/itineraries/{ITN_PAID}")
    assert r.status_code == 200
    tk = r.json().get("payment_token")
    assert tk
    return tk


@pytest.fixture(scope="module")
def clean_token(client):
    r = client.get(f"{BASE_URL}/api/itineraries/{ITN_CLEAN}")
    assert r.status_code == 200
    tk = r.json().get("payment_token")
    assert tk
    return tk


# ---------------------------------------------------------------------------
# Public payment landing — captured_payments[] surfaced
# ---------------------------------------------------------------------------
class TestPublicPayment:
    def test_captured_payments_present_for_paid_itinerary(self, paid_token):
        r = requests.get(f"{BASE_URL}/api/payments/{paid_token}")
        assert r.status_code == 200, r.text
        d = r.json()
        assert "captured_payments" in d
        assert isinstance(d["captured_payments"], list)
        assert len(d["captured_payments"]) >= 1
        cp = d["captured_payments"][0]
        # Fields required by the split-mode UI list.
        for k in ("kind", "amount_eur", "paid_at"):
            assert k in cp, f"missing {k} in captured_payments entry"
        assert "payer_name" in cp  # nullable but must exist
        assert "share_label" in cp
        # No leakage of internal ids
        assert "payment_id" not in cp
        assert "paypal_order_id" not in cp
        assert "paypal_capture_id" not in cp

    def test_paid_eur_positive_for_paid_itinerary(self, paid_token):
        r = requests.get(f"{BASE_URL}/api/payments/{paid_token}")
        d = r.json()
        assert (d.get("paid_eur") or 0) > 0

    def test_clean_itinerary_no_captured_payments(self, clean_token):
        r = requests.get(f"{BASE_URL}/api/payments/{clean_token}")
        assert r.status_code == 200
        d = r.json()
        assert d.get("captured_payments") == [] or d.get("captured_payments") is None or len(d["captured_payments"]) == 0
        assert (d.get("paid_eur") or 0) == 0


# ---------------------------------------------------------------------------
# Split payment — create-order accepts payer_name/payer_email/share_label
# ---------------------------------------------------------------------------
class TestSplitPayment:
    def test_create_order_accepts_split_fields(self, paid_token):
        # Compute a valid partial amount from the API bounds so the test is
        # not brittle to the itinerary total changing over time.
        landing = requests.get(f"{BASE_URL}/api/payments/{paid_token}").json()
        bounds = landing.get("partial_bounds") or {}
        amount = bounds.get("min_eur") or 100.0
        body = {
            "kind": "partial",
            "amount_eur": amount,
            "origin": BASE_URL,
            "payer_name": "TEST Ana Split",
            "payer_email": "ana.test@example.com",
            "share_label": "Cuota 1/2",
        }
        r = requests.post(
            f"{BASE_URL}/api/payments/{paid_token}/create-order", json=body,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert "approval_url" in data
        assert data["approval_url"].startswith("http")
        assert data.get("paypal_order_id")

    def test_create_order_without_split_still_works(self, paid_token):
        # Regression: existing non-split flow (no payer_* fields) must not
        # break after the split-payment fields were added.
        landing = requests.get(f"{BASE_URL}/api/payments/{paid_token}").json()
        bounds = landing.get("partial_bounds") or {}
        amount = bounds.get("min_eur") or 100.0
        r = requests.post(
            f"{BASE_URL}/api/payments/{paid_token}/create-order",
            json={"kind": "partial", "amount_eur": amount, "origin": BASE_URL},
        )
        assert r.status_code == 200, r.text
        assert "approval_url" in r.json()


# ---------------------------------------------------------------------------
# Post-sale extras CRUD
# ---------------------------------------------------------------------------
class TestPostSaleExtras:
    created_extra_id: str = ""
    extra_token: str = ""

    def test_create_extra(self, client):
        body = {"title": "TEST_Safari Extra",
                "description": "Test extra activity",
                "amount_eur": 120.5,
                "date": "2026-04-10"}
        r = client.post(f"{BASE_URL}/api/itineraries/{ITN_PAID}/extras", json=body)
        assert r.status_code == 200, r.text
        e = r.json()
        assert e["title"] == "TEST_Safari Extra"
        assert e["amount_eur"] == 120.5
        assert e["status"] == "sent"
        assert e.get("payment_token")
        assert e.get("extra_id")
        TestPostSaleExtras.created_extra_id = e["extra_id"]
        TestPostSaleExtras.extra_token = e["payment_token"]

    def test_reject_zero_amount(self, client):
        r = client.post(
            f"{BASE_URL}/api/itineraries/{ITN_PAID}/extras",
            json={"title": "bad", "amount_eur": 0},
        )
        assert r.status_code == 400

    def test_list_extras(self, client):
        r = client.get(f"{BASE_URL}/api/itineraries/{ITN_PAID}/extras")
        assert r.status_code == 200
        extras = r.json().get("extras") or []
        assert any(e.get("extra_id") == TestPostSaleExtras.created_extra_id for e in extras)

    def test_public_extra_landing(self):
        assert TestPostSaleExtras.extra_token, "extra_token not set — create test failed"
        r = requests.get(f"{BASE_URL}/api/payments/extra/{TestPostSaleExtras.extra_token}")
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["title"] == "TEST_Safari Extra"
        assert d["amount_eur"] == 120.5
        assert d["status"] == "sent"
        assert d.get("trip_name")
        assert d.get("currency") == "EUR"

    def test_public_extra_landing_invalid_token(self):
        r = requests.get(f"{BASE_URL}/api/payments/extra/does_not_exist")
        assert r.status_code == 404

    def test_public_extra_create_order(self):
        token = TestPostSaleExtras.extra_token
        assert token
        body = {"origin": "https://itinerary-builder-74.preview.emergentagent.com",
                "payer_name": "TEST Extra Payer",
                "payer_email": "extra.test@example.com"}
        r = requests.post(f"{BASE_URL}/api/payments/extra/{token}/create-order", json=body)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "approval_url" in data
        assert data["approval_url"].startswith("http")

    def test_delete_extra(self, client):
        eid = TestPostSaleExtras.created_extra_id
        assert eid
        r = client.delete(f"{BASE_URL}/api/itineraries/{ITN_PAID}/extras/{eid}")
        assert r.status_code == 200, r.text
        # Verify no longer listed
        r2 = client.get(f"{BASE_URL}/api/itineraries/{ITN_PAID}/extras")
        extras = r2.json().get("extras") or []
        assert not any(e.get("extra_id") == eid for e in extras)


# ---------------------------------------------------------------------------
# Refund workflow
# ---------------------------------------------------------------------------
class TestRefunds:
    refund_id: str = ""

    def test_create_refund_request(self, client):
        body = {"payment_id": CAPTURED_PAYMENT_ID,
                "amount_eur": 100.0,
                "reason": "TEST refund reason"}
        r = client.post(f"{BASE_URL}/api/itineraries/{ITN_PAID}/refund-requests", json=body)
        assert r.status_code == 200, r.text
        rf = r.json()
        assert rf["status"] == "pending"
        assert rf["amount_eur"] == 100.0
        assert rf["requested_by"]
        assert rf.get("refund_id")
        TestRefunds.refund_id = rf["refund_id"]

    def test_list_refund_requests(self, client):
        r = client.get(f"{BASE_URL}/api/itineraries/{ITN_PAID}/refund-requests")
        assert r.status_code == 200
        d = r.json()
        assert "refund_requests" in d
        assert "is_approver" in d
        assert "approver_emails" in d
        assert set(d["approver_emails"]) == {"beatriz@viajadverdad.com", "marina@viajadverdad.com"}
        # eduardo is not an approver
        assert d["is_approver"] is False
        assert any(r.get("refund_id") == TestRefunds.refund_id for r in d["refund_requests"])

    def test_amount_above_refundable_rejected(self, client):
        body = {"payment_id": CAPTURED_PAYMENT_ID,
                "amount_eur": 99999999.0,
                "reason": "TEST too much"}
        r = client.post(f"{BASE_URL}/api/itineraries/{ITN_PAID}/refund-requests", json=body)
        assert r.status_code == 400
        assert "reembolsable" in r.text.lower() or "cantidad" in r.text.lower()

    def test_zero_or_negative_rejected(self, client):
        body = {"payment_id": CAPTURED_PAYMENT_ID,
                "amount_eur": 0,
                "reason": "bad"}
        r = client.post(f"{BASE_URL}/api/itineraries/{ITN_PAID}/refund-requests", json=body)
        assert r.status_code == 400

    def test_unknown_payment_id_rejected(self, client):
        body = {"payment_id": "pmt_does_not_exist",
                "amount_eur": 10.0}
        r = client.post(f"{BASE_URL}/api/itineraries/{ITN_PAID}/refund-requests", json=body)
        assert r.status_code == 404

    def test_non_manager_approve_forbidden(self, client):
        rid = TestRefunds.refund_id
        assert rid
        r = client.post(
            f"{BASE_URL}/api/itineraries/{ITN_PAID}/refund-requests/{rid}/approve",
            json={},
        )
        assert r.status_code == 403
        assert "beatriz" in r.text.lower() or "marina" in r.text.lower() or "aprobar" in r.text.lower()

    def test_non_manager_reject_forbidden(self, client):
        rid = TestRefunds.refund_id
        assert rid
        r = client.post(
            f"{BASE_URL}/api/itineraries/{ITN_PAID}/refund-requests/{rid}/reject",
            json={"reason": "TEST"},
        )
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# Cleanup: remove the pending refund we created (best-effort — will succeed
# because eduardo owns the itinerary, but the doc surgery is via Mongo. We
# just leave the pending row; it's clearly TEST-tagged in `reason`.)
# ---------------------------------------------------------------------------
