"""
Backend test for the Sofi push integration (iteration 4).

Covers:
  - POST /api/itineraries/{id}/push-to-sofi with dry_run=true
    → returns job_id+status=running, poll yields status=done with
      result.ok, result.dry_run, result.filled_fields, result.screenshot_b64
    → itinerary doc NOT stamped with sofi_trip_id
  - 404 on push for unknown itinerary_id
  - 404 on status for unknown job_id
  - GET /api/itineraries/{id} surfaces sofi_trip_id / sofi_url / sofi_pushed_at
    (all None when not pushed)
  - 409 on real push (dry_run=false) when itinerary already has sofi_trip_id
    (we set it manually via DB to avoid creating a real trip in Sofi prod)
  - Real push (dry_run=false) is SKIPPED — would create a permanent row in
    gestion.viajadverdad.com prod. Re-enable via env SOFI_RUN_REAL_PUSH=1.
"""
import os
import time
import json
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://itinerary-builder-74.preview.emergentagent.com").rstrip("/")
SESSION_TOKEN = "3rrWWDXfC1ze9MEHqZzbC0eQK3nq29wClvsJPIMsQhc"
TEST_ITN_ID = "itn_708e44718bc6"   # Pepe Perez Tour — confirmed exists, no sofi_trip_id

# Generous timeout — Playwright Chromium boot + Sofi login + 16-field fill ≈ 40-90s,
# allow up to 6 min to match server-side _run_sofi_push_job_safely().
POLL_TIMEOUT_S = 360
POLL_INTERVAL_S = 3


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Cookie": f"session_token={SESSION_TOKEN}"})
    return s


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


# ------------------------ basic itinerary fields ------------------------
class TestItineraryShape:
    def test_get_itinerary_includes_sofi_fields(self, client):
        r = client.get(f"{BASE_URL}/api/itineraries/{TEST_ITN_ID}")
        assert r.status_code == 200, r.text
        doc = r.json()
        # Fields must exist (even if null) so the frontend can branch on them.
        assert "sofi_trip_id" in doc
        assert "sofi_url" in doc
        assert "sofi_pushed_at" in doc
        # Pre-push state — all None.
        assert doc["sofi_trip_id"] is None
        assert doc["sofi_url"] is None
        assert doc["sofi_pushed_at"] is None


# ------------------------ 404 paths ------------------------
class Test404Paths:
    def test_push_unknown_itinerary_returns_404(self, client):
        r = client.post(
            f"{BASE_URL}/api/itineraries/itn_does_not_exist_xxx/push-to-sofi",
            json={"dry_run": True},
        )
        assert r.status_code == 404, r.text
        assert "no encontrado" in r.text.lower() or "not found" in r.text.lower()

    def test_status_unknown_job_returns_404(self, client):
        r = client.get(f"{BASE_URL}/api/itineraries/push-to-sofi/sofi_doesnotexist")
        assert r.status_code == 404, r.text


# ------------------------ dry-run happy path ------------------------
class TestDryRun:
    def test_dry_run_returns_filled_form_and_screenshot(self, client):
        # Kick off
        r = client.post(
            f"{BASE_URL}/api/itineraries/{TEST_ITN_ID}/push-to-sofi",
            json={"dry_run": True},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("status") == "running"
        assert body.get("dry_run") is True
        job_id = body.get("job_id")
        assert isinstance(job_id, str) and job_id.startswith("sofi_")

        # Poll
        final = _poll(client, job_id)
        assert final["status"] == "done", f"dry-run did not complete cleanly: {json.dumps(final)[:600]}"
        assert final.get("dry_run") is True
        result = final.get("result") or {}
        assert result.get("ok") is True, f"result.ok not true: {json.dumps(result)[:600]}"
        assert result.get("dry_run") is True
        # filled_fields must be a non-empty list
        assert isinstance(result.get("filled_fields"), list)
        assert len(result["filled_fields"]) > 0, "filled_fields should not be empty"
        # screenshot_b64 must be a non-empty base64 string (PNG-ish)
        ss = result.get("screenshot_b64")
        assert isinstance(ss, str) and len(ss) > 1000, f"screenshot_b64 too short: {len(ss) if ss else 0}"

    def test_dry_run_does_not_set_sofi_trip_id(self, client):
        # After the previous dry-run, the doc must still have NO sofi_trip_id.
        r = client.get(f"{BASE_URL}/api/itineraries/{TEST_ITN_ID}")
        assert r.status_code == 200
        doc = r.json()
        assert doc.get("sofi_trip_id") is None, "dry-run must NOT stamp sofi_trip_id"
        assert doc.get("sofi_url") is None
        assert doc.get("sofi_pushed_at") is None


# ------------------------ 409 conflict on already-pushed ------------------------
class TestAlreadyPushedConflict:
    """We can't actually call dry_run=false without creating a real Sofi trip,
    so we simulate the post-push state by stamping sofi_trip_id directly via the
    DB. Then we verify the 409 guard fires for dry_run=false and that dry_run=true
    is still allowed."""

    @pytest.fixture(scope="class")
    def stamped_itn(self):
        """Pick a fresh itinerary, stamp sofi_trip_id=9999999, yield id, then unstamp."""
        # use a different itinerary so we don't clobber the dry-run test above
        from pymongo import MongoClient
        mongo_url = os.environ.get("MONGO_URL")
        db_name = os.environ.get("DB_NAME")
        if not mongo_url or not db_name:
            pytest.skip("MONGO_URL/DB_NAME not available in this environment")
        mc = MongoClient(mongo_url)
        col = mc[db_name].itineraries
        # find any itinerary owned by eduardo and currently unpushed, NOT the
        # one used in TestDryRun
        candidate = col.find_one(
            {"itinerary_id": {"$ne": TEST_ITN_ID},
             "sofi_trip_id": {"$in": [None, ""]}},
            {"itinerary_id": 1, "_id": 0},
        )
        if not candidate:
            pytest.skip("no spare unpushed itinerary to use for 409 test")
        itn_id = candidate["itinerary_id"]
        col.update_one(
            {"itinerary_id": itn_id},
            {"$set": {
                "sofi_trip_id": 9999999,
                "sofi_url": "https://gestion.viajadverdad.com/trips/details/1/9999999",
                "sofi_pushed_at": "2026-01-01T00:00:00Z",
                "_TEST_sofi_stamp": True,
            }},
        )
        yield itn_id
        # teardown — un-stamp
        col.update_one(
            {"itinerary_id": itn_id},
            {"$set": {"sofi_trip_id": None, "sofi_url": None,
                      "sofi_pushed_at": None},
             "$unset": {"_TEST_sofi_stamp": ""}},
        )

    def test_real_push_after_already_pushed_returns_409(self, client, stamped_itn):
        r = client.post(
            f"{BASE_URL}/api/itineraries/{stamped_itn}/push-to-sofi",
            json={"dry_run": False},
        )
        assert r.status_code == 409, f"expected 409, got {r.status_code}: {r.text}"
        body = r.json()
        detail = body.get("detail", "")
        # Spanish-language message expected
        assert "sofi" in detail.lower()
        assert "9999999" in detail or "ya está" in detail.lower() or "duplicado" in detail.lower()

    def test_dry_run_after_already_pushed_still_allowed(self, client, stamped_itn):
        # dry_run on a pushed itinerary should NOT raise 409 — it just starts the job.
        r = client.post(
            f"{BASE_URL}/api/itineraries/{stamped_itn}/push-to-sofi",
            json={"dry_run": True},
        )
        assert r.status_code == 200, f"dry_run should be allowed even after push: {r.status_code} {r.text}"
        body = r.json()
        assert body.get("status") == "running"
        assert body.get("dry_run") is True
        # We don't need to wait for the dry-run to complete here — the 409
        # guard is the assertion under test. Cancel-ish: just verify the job
        # exists in the status endpoint.
        job_id = body["job_id"]
        r2 = client.get(f"{BASE_URL}/api/itineraries/push-to-sofi/{job_id}")
        assert r2.status_code == 200


# ------------------------ optional: real push (skipped by default) ------------------------
@pytest.mark.skipif(
    os.environ.get("SOFI_RUN_REAL_PUSH") != "1",
    reason="skipped — would create a real trip in Sofi production (set SOFI_RUN_REAL_PUSH=1 to enable)",
)
def test_real_push_creates_sofi_trip_and_stamps_doc(client):
    """OPTIONAL — actually pushes to Sofi prod. Uses TEST AUTO PUSH traveler
    name so the agency can identify and delete the row."""
    r = client.post(
        f"{BASE_URL}/api/itineraries/{TEST_ITN_ID}/push-to-sofi",
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
    # confirm persistence
    r2 = client.get(f"{BASE_URL}/api/itineraries/{TEST_ITN_ID}")
    doc = r2.json()
    assert doc["sofi_trip_id"] == result["trip_id"]
    assert doc["sofi_url"] == result["url"]
    assert doc["sofi_pushed_at"] is not None
