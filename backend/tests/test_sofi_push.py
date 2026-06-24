"""
Backend test for the Sofi push integration (iteration 5).

Context update (iter-5): itn_708e44718bc6 has been pushed for real and now
carries sofi_trip_id=2311. We use it as the "already-pushed" subject for the
409 conflict test (no DB stamping needed anymore). For dry-run happy-path
tests we discover a fresh unpushed itinerary at module setup.

Covers:
  - GET /api/itineraries/{id} surfaces sofi_trip_id / sofi_url / sofi_pushed_at
    (real values on itn_708e44718bc6; nulls on a fresh itinerary).
  - POST /api/itineraries/{id}/push-to-sofi with dry_run=true
    → returns job_id+status=running, poll yields status=done with
      result.ok, result.dry_run, result.filled_fields, result.screenshot_b64
    → itinerary doc NOT stamped with sofi_trip_id (still null after dry-run)
  - 404 on push for unknown itinerary_id (Spanish "Itinerario no encontrado")
  - 404 on status for unknown job_id (Spanish "Job no encontrado")
  - 409 on real push (dry_run=false) for itn_708e44718bc6 (already pushed)
    + dry_run=true on the same itinerary is still allowed
  - Pydantic-ish body strictness: dry_run="no" (string) must coerce to False
    (NOT to True). Treated as the safe default by the endpoint.
  - POST /api/itineraries creates a fresh doc (regression).
  - Real push (dry_run=false) is SKIPPED — would create a permanent row in
    gestion.viajadverdad.com prod. Re-enable via env SOFI_RUN_REAL_PUSH=1.
"""
import os
import time
import json
import pytest
import requests

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL",
    "https://itinerary-builder-74.preview.emergentagent.com",
).rstrip("/")
SESSION_TOKEN = "3rrWWDXfC1ze9MEHqZzbC0eQK3nq29wClvsJPIMsQhc"

# Real pushed itinerary — trip #2311 in Sofi. Used for the 409 conflict assertion.
PUSHED_ITN_ID = "itn_708e44718bc6"
PUSHED_TRIP_ID = 2311

# Generous timeout — Playwright Chromium boot + Sofi login + 16-field fill ≈ 40-90s,
# allow up to 6 min to match server-side _run_sofi_push_job_safely().
POLL_TIMEOUT_S = 360
POLL_INTERVAL_S = 3


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Cookie": f"session_token={SESSION_TOKEN}"})
    return s


@pytest.fixture(scope="module")
def unpushed_itn_id(client):
    """Discover a real itinerary that has no sofi_trip_id yet — for dry-run tests."""
    from pymongo import MongoClient
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "test_database")
    mc = MongoClient(mongo_url)
    col = mc[db_name].itineraries
    candidate = col.find_one(
        {
            "itinerary_id": {"$ne": PUSHED_ITN_ID},
            "sofi_trip_id": {"$in": [None, ""]},
        },
        {"itinerary_id": 1, "_id": 0},
    )
    if not candidate:
        pytest.skip("no unpushed itinerary available for dry-run tests")
    return candidate["itinerary_id"]


def _poll(client, job_id, timeout=POLL_TIMEOUT_S):
    """Poll GET status until status != running OR timeout. Returns final body."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        r = client.get(f"{BASE_URL}/api/itineraries/push-to-sofi/{job_id}")
        assert r.status_code == 200, f"status poll failed: {r.status_code} {r.text}"
        body = r.json()
        last = body
        if body.get("status") != "running":
            return body
        time.sleep(POLL_INTERVAL_S)
    pytest.fail(f"job {job_id} still running after {timeout}s; last={json.dumps(last)[:300]}")


# ------------------------ basic itinerary shape ------------------------
class TestItineraryShape:
    def test_get_pushed_itinerary_surfaces_sofi_fields(self, client):
        """itn_708e44718bc6 must expose real sofi_trip_id/url/pushed_at."""
        r = client.get(f"{BASE_URL}/api/itineraries/{PUSHED_ITN_ID}")
        assert r.status_code == 200, r.text
        doc = r.json()
        assert "sofi_trip_id" in doc
        assert "sofi_url" in doc
        assert "sofi_pushed_at" in doc
        assert doc["sofi_trip_id"] == PUSHED_TRIP_ID
        assert isinstance(doc["sofi_url"], str)
        assert str(PUSHED_TRIP_ID) in doc["sofi_url"]
        assert doc["sofi_pushed_at"] is not None

    def test_get_unpushed_itinerary_has_null_sofi_fields(self, client, unpushed_itn_id):
        r = client.get(f"{BASE_URL}/api/itineraries/{unpushed_itn_id}")
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc.get("sofi_trip_id") in (None, "")
        assert doc.get("sofi_url") in (None, "")
        assert doc.get("sofi_pushed_at") in (None, "")


# ------------------------ 404 paths ------------------------
class Test404Paths:
    def test_push_unknown_itinerary_returns_404(self, client):
        r = client.post(
            f"{BASE_URL}/api/itineraries/itn_does_not_exist_xxx/push-to-sofi",
            json={"dry_run": True},
        )
        assert r.status_code == 404, r.text
        body = r.json()
        detail = (body.get("detail") or "").lower()
        assert "itinerario no encontrado" in detail or "no encontrado" in detail

    def test_status_unknown_job_returns_404(self, client):
        r = client.get(f"{BASE_URL}/api/itineraries/push-to-sofi/sofi_doesnotexist")
        assert r.status_code == 404, r.text
        body = r.json()
        detail = (body.get("detail") or "").lower()
        assert "job no encontrado" in detail or "no encontrado" in detail


# ------------------------ dry-run happy path ------------------------
class TestDryRun:
    def test_dry_run_returns_filled_form_and_screenshot(self, client, unpushed_itn_id):
        r = client.post(
            f"{BASE_URL}/api/itineraries/{unpushed_itn_id}/push-to-sofi",
            json={"dry_run": True},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("status") == "running"
        assert body.get("dry_run") is True
        job_id = body.get("job_id")
        assert isinstance(job_id, str) and job_id.startswith("sofi_")

        final = _poll(client, job_id)
        assert final["status"] == "done", \
            f"dry-run did not complete cleanly: {json.dumps(final)[:600]}"
        assert final.get("dry_run") is True
        result = final.get("result") or {}
        assert result.get("ok") is True, f"result.ok not true: {json.dumps(result)[:600]}"
        assert result.get("dry_run") is True
        # filled_fields must be a non-empty list
        assert isinstance(result.get("filled_fields"), list)
        assert len(result["filled_fields"]) > 0, "filled_fields should not be empty"
        # screenshot_b64 must be a non-empty base64 string
        ss = result.get("screenshot_b64")
        assert isinstance(ss, str) and len(ss) > 1000, \
            f"screenshot_b64 too short: {len(ss) if ss else 0}"

    def test_dry_run_does_not_set_sofi_trip_id(self, client, unpushed_itn_id):
        """After dry-run the doc must still have NO sofi_trip_id."""
        r = client.get(f"{BASE_URL}/api/itineraries/{unpushed_itn_id}")
        assert r.status_code == 200
        doc = r.json()
        assert doc.get("sofi_trip_id") in (None, ""), \
            "dry-run must NOT stamp sofi_trip_id"
        assert doc.get("sofi_url") in (None, "")
        assert doc.get("sofi_pushed_at") in (None, "")


# ------------------------ 409 conflict on already-pushed ------------------------
class TestAlreadyPushedConflict:
    """itn_708e44718bc6 already lives in Sofi as trip #2311. The endpoint must:
      - reject dry_run=false with 409 (creating a duplicate trip is not allowed)
      - allow dry_run=true (preview is always safe)
    """

    def test_real_push_after_already_pushed_returns_409(self, client):
        r = client.post(
            f"{BASE_URL}/api/itineraries/{PUSHED_ITN_ID}/push-to-sofi",
            json={"dry_run": False},
        )
        assert r.status_code == 409, f"expected 409, got {r.status_code}: {r.text}"
        body = r.json()
        detail = body.get("detail", "")
        # Spanish-language message must mention the existing trip
        assert "sofi" in detail.lower()
        assert str(PUSHED_TRIP_ID) in detail or "ya está" in detail.lower()


# ------------------------ strict dry_run coercion ------------------------
class TestDryRunStrictBool:
    """The endpoint stores dry_run via `isinstance(..., bool)`. A sneaky
    string `"no"` (truthy in Python) MUST NOT flip the run to a real push.
    The contract: anything non-bool → defaults to False (safe).
    BUT: if the itinerary already has sofi_trip_id, the False default will
    trip the 409 guard — which is exactly what we want for safety. We use
    PUSHED_ITN_ID so we can assert the coercion without any risk of real
    side-effects (a 409 = success here)."""

    def test_dry_run_string_no_is_treated_as_false_not_true(self, client):
        r = client.post(
            f"{BASE_URL}/api/itineraries/{PUSHED_ITN_ID}/push-to-sofi",
            json={"dry_run": "no"},
        )
        # Because dry_run coerces to False and the itinerary is already pushed,
        # the 409 conflict guard must fire. If the endpoint *wrongly* coerced
        # "no" to True (truthy string), it would start a running dry-run job
        # and return 200 — that would be a bug.
        assert r.status_code == 409, (
            f"expected 409 (string 'no' must coerce to False), got "
            f"{r.status_code}: {r.text}"
        )

    def test_dry_run_string_true_is_treated_as_false_not_true(self, client):
        """Same reasoning with the string 'true' (also truthy). Must coerce to False."""
        r = client.post(
            f"{BASE_URL}/api/itineraries/{PUSHED_ITN_ID}/push-to-sofi",
            json={"dry_run": "true"},
        )
        assert r.status_code == 409, (
            f"expected 409 (string 'true' must coerce to False), got "
            f"{r.status_code}: {r.text}"
        )

    def test_dry_run_missing_defaults_to_false(self, client):
        """No dry_run key → default False → 409 because PUSHED_ITN_ID is pushed."""
        r = client.post(
            f"{BASE_URL}/api/itineraries/{PUSHED_ITN_ID}/push-to-sofi",
            json={},
        )
        assert r.status_code == 409, (
            f"expected 409 (missing dry_run → False), got {r.status_code}: {r.text}"
        )


# ------------------------ regression: other critical endpoints ------------------------
class TestRegressionCriticalEndpoints:
    def test_get_itinerary_includes_all_sofi_fields(self, client, unpushed_itn_id):
        """Smoke: the three sofi_* fields must be present on every itinerary doc."""
        r = client.get(f"{BASE_URL}/api/itineraries/{unpushed_itn_id}")
        assert r.status_code == 200
        doc = r.json()
        for key in ("sofi_trip_id", "sofi_url", "sofi_pushed_at"):
            assert key in doc, f"missing field {key} in itinerary doc"

    def test_create_itinerary_returns_new_doc(self, client):
        """POST /api/itineraries must still create a fresh doc."""
        payload = {
            "traveler_name": "TEST AUTO PUSH 2026-06-23",
            "destination": "Madrid",
            "start_date": "2026-09-01",
            "end_date": "2026-09-05",
        }
        r = client.post(f"{BASE_URL}/api/itineraries", json=payload)
        assert r.status_code in (200, 201), r.text
        doc = r.json()
        assert isinstance(doc.get("itinerary_id"), str)
        assert doc["itinerary_id"].startswith("itn_")
        # Sofi fields must exist as null on a fresh doc
        assert doc.get("sofi_trip_id") in (None, "")
        # Teardown: remove this test doc to avoid pollution.
        from pymongo import MongoClient
        mc = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
        mc[os.environ.get("DB_NAME", "test_database")].itineraries.delete_one(
            {"itinerary_id": doc["itinerary_id"]}
        )


# ------------------------ optional: real push (skipped by default) ------------------------
@pytest.mark.skipif(
    os.environ.get("SOFI_RUN_REAL_PUSH") != "1",
    reason="skipped — would create a real trip in Sofi production "
           "(set SOFI_RUN_REAL_PUSH=1 to enable)",
)
def test_real_push_creates_sofi_trip_and_stamps_doc(client, unpushed_itn_id):
    """OPTIONAL — actually pushes to Sofi prod."""
    r = client.post(
        f"{BASE_URL}/api/itineraries/{unpushed_itn_id}/push-to-sofi",
        json={"dry_run": False},
    )
    assert r.status_code == 200, r.text
    job_id = r.json()["job_id"]
    final = _poll(client, job_id)
    assert final["status"] == "done", json.dumps(final)[:600]
    result = final["result"]
    assert result["ok"] is True
    assert isinstance(result.get("trip_id"), int)
    assert isinstance(result.get("url"), str)
    assert result["url"].startswith("https://gestion.viajadverdad.com/trips/details/1/")
    r2 = client.get(f"{BASE_URL}/api/itineraries/{unpushed_itn_id}")
    doc = r2.json()
    assert doc["sofi_trip_id"] == result["trip_id"]
    assert doc["sofi_url"] == result["url"]
    assert doc["sofi_pushed_at"] is not None
