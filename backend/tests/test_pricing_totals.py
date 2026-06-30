"""Unit tests for `_compute_pricing_totals` — the gross-up commission
formula. The previous (naive) shape was `commission_eur = sub × c/100`
which silently shrank the agency's net markup on every Zicasso /
Responsible Travel / Baboo trip because the partner deducts their cut
from the FINAL sale price, not from the markup.

The new shape is `commission_eur = sub × c / (100 − c)`, equivalent to
selling at `sub / (1 − c/100)`. AFTER the partner takes their cut the
agency nets exactly `sub` again.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import _compute_pricing_totals


def _make(sub_incl: float, markup_pct: float, commission_pct: float,
          paypal_fee: bool = False) -> dict:
    """Build a minimal itinerary doc with a single service so `sub_incl`
    ends up equal to the argument."""
    return {
        "days": [{
            "services": [{
                "unit_price_tax_incl": sub_incl,
                "unit_price_tax_excl": sub_incl / 1.21,
                "quantity": 1,
            }],
        }],
        "accommodations": [],
        "markup_pct": markup_pct,
        "commission_pct": commission_pct,
        "paypal_fee": paypal_fee,
    }


def test_zicasso_example_nets_exactly_300_markup():
    """Cost 1.000 €, desired markup 30 %, partner takes 10.5 % deductive.
    PVP must be 1452.51 €, partner cuts 152.51 €, agency nets exactly 300 €."""
    t = _compute_pricing_totals(_make(1000.0, 30.0, 10.5))
    assert t["sub_incl"] == 1000.0
    assert t["sub_with_markup"] == 1300.0
    assert t["commission_eur"] == 152.51
    assert t["pvp"] == 1452.51
    # AFTER the partner deducts their %, the agency's net = sub_with_markup
    partner_cut = t["pvp"] * 0.105
    net = t["pvp"] - partner_cut - 1000.0
    assert abs(net - 300.0) < 0.01, f"net was {net}"


def test_responsible_travel_7pct_grossup():
    """Cost 5.000 €, desired markup 30 %, partner = RT 7 %."""
    t = _compute_pricing_totals(_make(5000.0, 30.0, 7.0))
    assert t["sub_with_markup"] == 6500.0
    # commission = 6500 × 7 / 93 = 489.247...  → rounds to 489.25
    assert t["commission_eur"] == 489.25
    # PVP = 6500 + 489.25 = 6989.25, partner cuts 7% = 489.25 → we keep 6500 ✓
    assert abs((t["pvp"] - t["pvp"] * 0.07) - 6500.0) < 0.01


def test_direct_partner_no_commission():
    """Direct sales have commission_pct=0 → commission_eur must be 0 too
    (no grossup, no division-by-zero)."""
    t = _compute_pricing_totals(_make(1000.0, 35.0, 0.0))
    assert t["commission_eur"] == 0.0
    assert t["pvp"] == 1350.0  # 1000 × 1.35


def test_paypal_fee_adds_3pct_on_top():
    """PayPal toggle adds 3% AFTER the markup + commission stack."""
    base = _compute_pricing_totals(_make(1000.0, 30.0, 10.5, paypal_fee=False))
    with_pp = _compute_pricing_totals(_make(1000.0, 30.0, 10.5, paypal_fee=True))
    assert with_pp["paypal_eur"] == round(base["pvp"] * 0.03, 2)
    assert abs(with_pp["pvp"] - base["pvp"] * 1.03) < 0.01


def test_legacy_kimkim_partner_still_computes():
    """KimKim is hidden from the UI but old itineraries can still carry
    partner='kimkim'. The totals function doesn't read `partner` — only
    the numeric markup_pct + commission_pct — so this is just a sanity
    check that we don't reference the partner string anywhere."""
    t = _compute_pricing_totals({**_make(1000.0, 33.0, 15.0), "partner": "kimkim"})
    # With grossup: 1330 + 1330*15/85 = 1330 + 234.71 = 1564.71
    assert t["pvp"] == 1564.71


def test_grossup_matches_excel_export_formula():
    """The Excel export at server.py:1775 already uses the gross-up shape:
        com_eur = sub_with_markup × com_pct / (100 − com_pct)
    The runtime totals MUST produce the same number, otherwise the UI
    and the Excel give different prices for the same trip."""
    for com_pct in (7.0, 10.0, 10.5, 12.0, 15.0):
        t = _compute_pricing_totals(_make(1000.0, 30.0, com_pct))
        sub_with_markup = 1300.0
        excel_com = round(sub_with_markup * com_pct / (100.0 - com_pct), 2)
        assert t["commission_eur"] == excel_com, (
            f"mismatch at com_pct={com_pct}: ui={t['commission_eur']} excel={excel_com}"
        )



# ---- Double-count protection for accommodation carrier services ----------

def test_acc_id_services_excluded_from_totals():
    """Legacy itineraries embed 'carrier services' inside `days[].services[]`
    with `acc_id` pointing to an entry in `accommodations[]`. Counting both
    would double-bill the hotel. The fix: skip any service with `acc_id`
    in the cost summation — accommodations carry the real cost."""
    itn = {
        "days": [{
            "date": "2026-08-01",
            "services": [
                # carrier service from old auto-spread (should be SKIPPED)
                {
                    "acc_id": "acc_old",
                    "name": "Check-in · Hotel Eden",
                    "quantity": 4,  # 2 nights × 2 rooms
                    "unit_price_tax_incl": 100.0,
                    "unit_price_tax_excl": 82.64,
                },
                # legitimate service (should be COUNTED)
                {
                    "name": "Transfer aeropuerto",
                    "quantity": 1,
                    "unit_price_tax_incl": 50.0,
                    "unit_price_tax_excl": 41.32,
                },
            ],
        }],
        "accommodations": [{
            "acc_id": "acc_old",
            "name": "Hotel Eden",
            "price_tax_incl": 400.0,    # 4 × 100, the real source of truth
            "price_tax_excl": 330.58,
        }],
        "markup_pct": 30,
        "commission_pct": 0,
        "paypal_fee": False,
    }
    t = _compute_pricing_totals(itn)
    # 400 (hotel) + 50 (transfer) = 450 — NOT 450 + 400 = 850.
    assert t["sub_incl"] == 450.0, f"got {t['sub_incl']}"
    assert t["sub_excl"] == 371.90, f"got {t['sub_excl']}"


def test_clean_itinerary_without_carriers_unchanged():
    """Sanity: new itineraries that DON'T carry acc_id services must still
    sum normally — the fix should be a no-op for them."""
    itn = {
        "days": [{"services": [{
            "name": "Free walking tour",
            "quantity": 2,
            "unit_price_tax_incl": 30.0,
        }]}],
        "accommodations": [{"name": "Hotel X", "price_tax_incl": 200.0}],
        "markup_pct": 30, "commission_pct": 0, "paypal_fee": False,
    }
    t = _compute_pricing_totals(itn)
    assert t["sub_incl"] == 260.0  # 60 + 200
