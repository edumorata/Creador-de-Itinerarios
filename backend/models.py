"""All Pydantic models + type aliases for the Travel Itinerary Builder.

Extracted from server.py during the v5 refactor so server.py stays focused on
route handlers and orchestration. Helpers `new_id` and `now_iso` are imported
from server.py to avoid a circular import — they're trivial and stay there.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field


# ---------------------------------------------------------------------------
# Tiny helpers (duplicated here to keep models.py importable without server.py)
# ---------------------------------------------------------------------------
def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Type aliases
# ---------------------------------------------------------------------------
ServiceType = Literal[
    "alojamiento", "actividad", "transporte", "restaurante",
    "transfer", "vuelo", "otro",
]
HotelTier = Literal["luxury", "upscale", "comfort", "standard", "budget"]
TripOutcome = Literal["sold", "not_sold", "pending"]
PartnerKind = Literal["kimkim", "zicasso", "responsible_travel", "direct", "other"]
BulkJobStatus = Literal[
    "queued", "running", "completed", "failed", "cancelled", "interrupted",
]


# ---------------------------------------------------------------------------
# Auth / users
# ---------------------------------------------------------------------------
class User(BaseModel):
    model_config = ConfigDict(extra="ignore")
    user_id: str
    email: EmailStr
    name: str
    picture: Optional[str] = None
    role: Literal["admin", "agent"] = "agent"
    created_at: str = Field(default_factory=now_iso)


class AllowedEmail(BaseModel):
    model_config = ConfigDict(extra="ignore")
    email: EmailStr
    role: Literal["admin", "agent"] = "agent"
    added_by: Optional[str] = None
    added_at: str = Field(default_factory=now_iso)


class AllowedEmailCreate(BaseModel):
    email: EmailStr
    role: Literal["admin", "agent"] = "agent"


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------
class Provider(BaseModel):
    model_config = ConfigDict(extra="ignore")
    provider_id: str = Field(default_factory=lambda: new_id("prov"))
    name: str
    country: Optional[str] = None
    contact: Optional[str] = None
    notes: Optional[str] = None
    created_at: str = Field(default_factory=now_iso)


class ProviderCreate(BaseModel):
    name: str
    country: Optional[str] = None
    contact: Optional[str] = None
    notes: Optional[str] = None


class ProviderUpdate(BaseModel):
    name: Optional[str] = None
    country: Optional[str] = None
    contact: Optional[str] = None
    notes: Optional[str] = None


# ---------------------------------------------------------------------------
# Experiences
# ---------------------------------------------------------------------------
class Experience(BaseModel):
    model_config = ConfigDict(extra="ignore")
    experience_id: str = Field(default_factory=lambda: new_id("exp"))
    title: str
    description: Optional[str] = None
    provider_id: str
    provider_name: Optional[str] = None  # denormalized for convenience
    country: Optional[str] = None
    city: Optional[str] = None
    type: ServiceType = "actividad"
    # Three-tier pricing: sin IVA, con IVA, PVP (calculated on top)
    price_tax_excl: float = 0.0
    price_tax_incl: float = 0.0
    price: float = 0.0  # legacy alias = price_tax_incl
    currency: str = "EUR"
    # Number of pax (adults + children) the price is quoted for. Critical for
    # interpreting per-group services where price scales with group size.
    # Default 2 to match the most common booking pattern.
    pax: int = 2
    notes: Optional[str] = None
    created_at: str = Field(default_factory=now_iso)


class ExperienceCreate(BaseModel):
    title: str
    description: Optional[str] = None
    provider_id: str
    country: Optional[str] = None
    city: Optional[str] = None
    type: ServiceType = "actividad"
    price_tax_excl: float = 0.0
    price_tax_incl: float = 0.0
    price: Optional[float] = None
    currency: str = "EUR"
    pax: int = 2
    notes: Optional[str] = None


class ExperienceUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    provider_id: Optional[str] = None
    country: Optional[str] = None
    city: Optional[str] = None
    type: Optional[ServiceType] = None
    price_tax_excl: Optional[float] = None
    price_tax_incl: Optional[float] = None
    price: Optional[float] = None
    currency: Optional[str] = None
    pax: Optional[int] = None
    notes: Optional[str] = None


# ---------------------------------------------------------------------------
# Hotels
# ---------------------------------------------------------------------------
class Hotel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    hotel_id: str = Field(default_factory=lambda: new_id("htl"))
    name: str
    city: Optional[str] = None
    country: Optional[str] = None
    tier: HotelTier = "upscale"
    description: Optional[str] = None
    price_per_night_excl: float = 0.0
    price_per_night_incl: float = 0.0
    currency: str = "EUR"
    contact: Optional[str] = None
    notes: Optional[str] = None
    # Where this hotel came from. Controls visibility:
    #  - 'library' = imported from the official Excel files (HOTELES <PAÍS>.xlsx).
    #               These are the ONLY hotels surfaced in the UI and used by the
    #               AI generator.
    #  - 'imported_from_trip' = auto-created from a scraped past trip. Hidden
    #               from listings, autocomplete and AI context.
    source: Literal["library", "imported_from_trip"] = "library"
    created_at: str = Field(default_factory=now_iso)


class HotelCreate(BaseModel):
    name: str
    city: Optional[str] = None
    country: Optional[str] = None
    tier: HotelTier = "upscale"
    description: Optional[str] = None
    price_per_night_excl: float = 0.0
    price_per_night_incl: float = 0.0
    currency: str = "EUR"
    contact: Optional[str] = None
    notes: Optional[str] = None


class HotelUpdate(BaseModel):
    name: Optional[str] = None
    city: Optional[str] = None
    country: Optional[str] = None
    tier: Optional[HotelTier] = None
    description: Optional[str] = None
    price_per_night_excl: Optional[float] = None
    price_per_night_incl: Optional[float] = None
    currency: Optional[str] = None
    contact: Optional[str] = None
    notes: Optional[str] = None


# ---------------------------------------------------------------------------
# Itinerary
# ---------------------------------------------------------------------------
class ItineraryService(BaseModel):
    """A single line inside an itinerary day."""
    service_id: str = Field(default_factory=lambda: new_id("svc"))
    experience_id: Optional[str] = None
    # Link back to a parent Accommodation row when this service was auto-created
    # by the "spread accommodation across days" flow (check-in / mid / check-out).
    # The UI uses this to clean up previous spreads when the hotel name or dates change.
    acc_id: Optional[str] = None
    type: ServiceType = "actividad"
    name: str
    provider_name: Optional[str] = None
    quantity: float = 1
    unit_price_tax_excl: float = 0.0
    unit_price_tax_incl: float = 0.0
    unit_price: float = 0.0  # legacy alias = unit_price_tax_incl
    currency: str = "EUR"
    notes: Optional[str] = None


class ItineraryDay(BaseModel):
    day_id: str = Field(default_factory=lambda: new_id("day"))
    date: Optional[str] = None
    label: Optional[str] = None
    city: Optional[str] = None
    services: List[ItineraryService] = Field(default_factory=list)


class Accommodation(BaseModel):
    acc_id: str = Field(default_factory=lambda: new_id("acc"))
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    name: str
    price_tax_excl: float = 0.0
    price_tax_incl: float = 0.0
    price: float = 0.0
    currency: str = "EUR"


class Traveler(BaseModel):
    first_name: str = ""
    last_name: str = ""


class Itinerary(BaseModel):
    model_config = ConfigDict(extra="ignore")
    itinerary_id: str = Field(default_factory=lambda: new_id("itn"))
    name: str = "Nuevo itinerario"
    main_traveler: str = ""
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    duration_days: int = 0
    num_travelers: int = 1
    travelers: List[Traveler] = Field(default_factory=list)
    days: List[ItineraryDay] = Field(default_factory=list)
    accommodations: List[Accommodation] = Field(default_factory=list)
    # Pricing model:
    #   PVP = subtotal_with_IVA × (1 + markup_pct/100) × (1 + commission_pct/100)
    # Defaults per partner (auto-applied on partner change, editable by agent):
    #   kimkim             → markup 33 + commission 15
    #   zicasso            → markup 30 + commission 10.5
    #   responsible_travel → markup 30 + commission 10
    #   direct             → markup 35 + commission  0
    #   other              → markup 30 + commission  0
    markup_pct: float = 33.0
    commission_pct: float = 15.0
    partner: Optional[PartnerKind] = "kimkim"
    currency: str = "EUR"
    status: Literal["draft", "sold", "not_sold"] = "draft"
    created_by: Optional[str] = None
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


class ItineraryUpsert(BaseModel):
    name: Optional[str] = None
    main_traveler: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    duration_days: Optional[int] = None
    num_travelers: Optional[int] = None
    travelers: Optional[List[Traveler]] = None
    days: Optional[List[ItineraryDay]] = None
    accommodations: Optional[List[Accommodation]] = None
    markup_pct: Optional[float] = None
    commission_pct: Optional[float] = None
    partner: Optional[PartnerKind] = None
    currency: Optional[str] = None
    status: Optional[Literal["draft", "sold", "not_sold"]] = None


# ---------------------------------------------------------------------------
# Training examples + bulk import jobs
# ---------------------------------------------------------------------------
class TrainingExample(BaseModel):
    model_config = ConfigDict(extra="ignore")
    example_id: str = Field(default_factory=lambda: new_id("trn"))
    client_name: Optional[str] = None
    client_request: str
    # Client-facing itinerary (Travefy or similar)
    itinerary_url: Optional[str] = None
    itinerary_text: Optional[str] = None
    itinerary_structured: Optional[dict] = None
    # Internal ops view (gestion.viajadverdad.com)
    itinerary_url_ops: Optional[str] = None
    itinerary_text_ops: Optional[str] = None
    itinerary_structured_ops: Optional[dict] = None
    outcome: TripOutcome = "pending"
    # Partner / source of the request. Each partner has a different commission
    # model that the AI generator must respect when pricing the draft.
    #  - kimkim             : KimKim adds 15% ON TOP of our price (additive)
    #  - zicasso            : Zicasso keeps 10.5% OF our price (deductive)
    #  - responsible_travel : Responsible Travel keeps 10% OF our price (deductive)
    #  - direct             : Direct booking, no partner commission
    #  - other              : catch-all for partners not yet modelled
    partner: Optional[PartnerKind] = "kimkim"
    notes: Optional[str] = None
    sales_agent: Optional[str] = None
    owner_agent: Optional[str] = None
    created_by: Optional[str] = None
    created_at: str = Field(default_factory=now_iso)


class TrainingExampleUpsert(BaseModel):
    client_name: Optional[str] = None
    client_request: Optional[str] = None
    itinerary_url: Optional[str] = None
    itinerary_text: Optional[str] = None
    itinerary_structured: Optional[dict] = None
    itinerary_url_ops: Optional[str] = None
    itinerary_text_ops: Optional[str] = None
    itinerary_structured_ops: Optional[dict] = None
    outcome: Optional[TripOutcome] = None
    partner: Optional[PartnerKind] = None
    notes: Optional[str] = None
    sales_agent: Optional[str] = None
    owner_agent: Optional[str] = None


class BulkImportJob(BaseModel):
    model_config = ConfigDict(extra="ignore")
    job_id: str = Field(default_factory=lambda: new_id("job"))
    status: BulkJobStatus = "queued"
    params: dict = Field(default_factory=dict)
    matched: int = 0
    scraped: int = 0
    skipped: int = 0
    failed: int = 0
    errors: List[str] = Field(default_factory=list)
    last_message: str = ""
    started_at: str = Field(default_factory=now_iso)
    finished_at: Optional[str] = None
    created_by: Optional[str] = None
    pending_trip_ids: List[str] = Field(default_factory=list)
    processed_trip_ids: List[str] = Field(default_factory=list)
    trip_names: dict = Field(default_factory=dict)
    listing_done: bool = False
    last_heartbeat: str = Field(default_factory=now_iso)
