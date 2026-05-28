"""
Travel Itinerary Builder - FastAPI backend.

Stack: FastAPI + Motor (MongoDB) + Emergent-managed Google Auth.
All routes are mounted under /api.
"""
from __future__ import annotations

import io
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, List, Literal, Optional

import httpx
import openpyxl
from bs4 import BeautifulSoup
from bson import ObjectId
from dotenv import load_dotenv
from fastapi import (
    APIRouter,
    Body,
    Cookie,
    Depends,
    FastAPI,
    File,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from motor.motor_asyncio import AsyncIOMotorClient
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from pydantic import BaseModel, BeforeValidator, ConfigDict, EmailStr, Field
from starlette.middleware.cors import CORSMiddleware

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
db_name = os.environ["DB_NAME"]
client = AsyncIOMotorClient(mongo_url)
db = client[db_name]

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("itinerary")

EMERGENT_SESSION_URL = "https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data"

# ---------------------------------------------------------------------------
# Pydantic helpers
# ---------------------------------------------------------------------------
def _to_str(v):
    if isinstance(v, ObjectId):
        return str(v)
    return v


PyObjectId = Annotated[str, BeforeValidator(_to_str)]


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
ServiceType = Literal["alojamiento", "actividad", "transporte", "restaurante", "transfer", "vuelo", "otro"]


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
    # Three-tier pricing: precio sin IVA, precio con IVA, PVP (calculated on top)
    price_tax_excl: float = 0.0
    price_tax_incl: float = 0.0
    price: float = 0.0  # legacy alias = price_tax_incl, kept for back-compat
    currency: str = "EUR"
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
    price: Optional[float] = None  # legacy
    currency: str = "EUR"
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
    notes: Optional[str] = None


class ItineraryService(BaseModel):
    """A single line inside an itinerary day."""
    service_id: str = Field(default_factory=lambda: new_id("svc"))
    experience_id: Optional[str] = None  # optional link to library
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
    date: Optional[str] = None  # ISO date string
    label: Optional[str] = None  # e.g. "Day 1"
    city: Optional[str] = None  # destination for the day, used as pre-filter
    services: List[ItineraryService] = Field(default_factory=list)


class Accommodation(BaseModel):
    acc_id: str = Field(default_factory=lambda: new_id("acc"))
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    name: str
    price_tax_excl: float = 0.0
    price_tax_incl: float = 0.0
    price: float = 0.0  # legacy
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
    markup_pct: float = 0.0
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
    currency: Optional[str] = None
    status: Optional[Literal["draft", "sold", "not_sold"]] = None


# ---------------------------------------------------------------------------
# App & router
# ---------------------------------------------------------------------------
app = FastAPI(title="Travel Itinerary Builder API")
api = APIRouter(prefix="/api")


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
async def get_session_token(
    request: Request,
    session_token_cookie: Annotated[Optional[str], Cookie(alias="session_token")] = None,
    authorization: Annotated[Optional[str], Header()] = None,
) -> Optional[str]:
    if session_token_cookie:
        return session_token_cookie
    if authorization and authorization.lower().startswith("bearer "):
        return authorization.split(" ", 1)[1].strip()
    return None


async def current_user(
    token: Annotated[Optional[str], Depends(get_session_token)],
) -> User:
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    session = await db.user_sessions.find_one({"session_token": token}, {"_id": 0})
    if not session:
        raise HTTPException(status_code=401, detail="Invalid session")

    expires_at = session.get("expires_at")
    if isinstance(expires_at, str):
        expires_at = datetime.fromisoformat(expires_at)
    if expires_at and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at and expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=401, detail="Session expired")

    user_doc = await db.users.find_one({"user_id": session["user_id"]}, {"_id": 0})
    if not user_doc:
        raise HTTPException(status_code=401, detail="User not found")
    return User(**user_doc)


async def require_admin(user: Annotated[User, Depends(current_user)]) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return user


# ---------------------------------------------------------------------------
# Auth endpoints
# ---------------------------------------------------------------------------
@api.post("/auth/session")
async def auth_session(response: Response, body: dict = Body(...)):
    """Exchange a session_id (from Emergent Auth redirect) for a session_token cookie."""
    session_id = body.get("session_id")
    if not session_id:
        raise HTTPException(status_code=400, detail="Missing session_id")

    async with httpx.AsyncClient(timeout=15) as http:
        r = await http.get(EMERGENT_SESSION_URL, headers={"X-Session-ID": session_id})
        if r.status_code != 200:
            logger.warning("Emergent auth error: %s %s", r.status_code, r.text)
            raise HTTPException(status_code=401, detail="Auth provider rejected session")
        profile = r.json()

    email = (profile.get("email") or "").lower().strip()
    if not email:
        raise HTTPException(status_code=400, detail="Email not provided by auth")

    # Whitelist check: allowed_emails OR first-login bootstrap (no admin yet)
    allowed = await db.allowed_emails.find_one({"email": email}, {"_id": 0})
    admin_count = await db.users.count_documents({"role": "admin"})

    if not allowed:
        if admin_count == 0:
            # bootstrap: first ever user becomes admin and is added to whitelist
            allowed = {"email": email, "role": "admin", "added_by": "bootstrap", "added_at": now_iso()}
            await db.allowed_emails.insert_one(dict(allowed))
            logger.info("Bootstrap admin created: %s", email)
        else:
            raise HTTPException(
                status_code=403,
                detail="Tu correo no está autorizado. Pide a un administrador que te añada a la whitelist.",
            )

    role = allowed.get("role", "agent")

    # upsert user
    user_doc = await db.users.find_one({"email": email}, {"_id": 0})
    if user_doc:
        await db.users.update_one(
            {"email": email},
            {"$set": {"name": profile.get("name") or user_doc.get("name"),
                      "picture": profile.get("picture"),
                      "role": role}},
        )
        user_id = user_doc["user_id"]
    else:
        user_id = f"user_{uuid.uuid4().hex[:12]}"
        await db.users.insert_one({
            "user_id": user_id,
            "email": email,
            "name": profile.get("name", email.split("@")[0]),
            "picture": profile.get("picture"),
            "role": role,
            "created_at": now_iso(),
        })

    session_token = profile.get("session_token") or uuid.uuid4().hex
    expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    await db.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": session_token,
        "expires_at": expires_at,
        "created_at": datetime.now(timezone.utc),
    })

    response.set_cookie(
        key="session_token",
        value=session_token,
        max_age=7 * 24 * 60 * 60,
        httponly=True,
        secure=True,
        samesite="none",
        path="/",
    )

    user = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    return {"user": user}


@api.get("/auth/me")
async def auth_me(user: Annotated[User, Depends(current_user)]):
    return user


@api.post("/auth/logout")
async def auth_logout(
    response: Response,
    token: Annotated[Optional[str], Depends(get_session_token)],
):
    if token:
        await db.user_sessions.delete_one({"session_token": token})
    response.delete_cookie("session_token", path="/")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Allowed emails (admin)
# ---------------------------------------------------------------------------
@api.get("/admin/allowed-emails", response_model=List[AllowedEmail])
async def list_allowed_emails(_: Annotated[User, Depends(require_admin)]):
    items = await db.allowed_emails.find({}, {"_id": 0}).sort("added_at", -1).to_list(1000)
    return items


@api.post("/admin/allowed-emails", response_model=AllowedEmail)
async def add_allowed_email(
    payload: AllowedEmailCreate,
    admin: Annotated[User, Depends(require_admin)],
):
    email = payload.email.lower().strip()
    existing = await db.allowed_emails.find_one({"email": email}, {"_id": 0})
    if existing:
        await db.allowed_emails.update_one({"email": email}, {"$set": {"role": payload.role}})
        existing["role"] = payload.role
        return existing
    doc = AllowedEmail(email=email, role=payload.role, added_by=admin.email).model_dump()
    await db.allowed_emails.insert_one(dict(doc))
    return doc


@api.delete("/admin/allowed-emails/{email}")
async def remove_allowed_email(email: str, admin: Annotated[User, Depends(require_admin)]):
    email = email.lower().strip()
    if email == admin.email:
        raise HTTPException(status_code=400, detail="No puedes eliminar tu propio acceso")
    res = await db.allowed_emails.delete_one({"email": email})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    # also revoke any active sessions
    user = await db.users.find_one({"email": email}, {"_id": 0})
    if user:
        await db.user_sessions.delete_many({"user_id": user["user_id"]})
    return {"ok": True}


@api.get("/admin/users", response_model=List[User])
async def list_users(_: Annotated[User, Depends(require_admin)]):
    items = await db.users.find({}, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return items


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------
@api.get("/providers", response_model=List[Provider])
async def list_providers(
    _: Annotated[User, Depends(current_user)],
    q: Optional[str] = None,
    country: Optional[str] = None,
):
    flt: dict = {}
    if q:
        flt["name"] = {"$regex": q, "$options": "i"}
    if country:
        flt["country"] = country
    items = await db.providers.find(flt, {"_id": 0}).sort("name", 1).to_list(2000)
    return items


@api.post("/providers", response_model=Provider)
async def create_provider(payload: ProviderCreate, _: Annotated[User, Depends(current_user)]):
    prov = Provider(**payload.model_dump())
    await db.providers.insert_one(prov.model_dump())
    return prov


@api.patch("/providers/{provider_id}", response_model=Provider)
async def update_provider(
    provider_id: str,
    payload: ProviderUpdate,
    _: Annotated[User, Depends(current_user)],
):
    patch = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
    if patch:
        await db.providers.update_one({"provider_id": provider_id}, {"$set": patch})
        # cascade: update denormalized provider_name on experiences
        if "name" in patch:
            await db.experiences.update_many(
                {"provider_id": provider_id}, {"$set": {"provider_name": patch["name"]}}
            )
    doc = await db.providers.find_one({"provider_id": provider_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    return doc


@api.delete("/providers/{provider_id}")
async def delete_provider(provider_id: str, _: Annotated[User, Depends(current_user)]):
    in_use = await db.experiences.count_documents({"provider_id": provider_id})
    if in_use > 0:
        raise HTTPException(status_code=400, detail=f"Proveedor en uso por {in_use} experiencias")
    res = await db.providers.delete_one({"provider_id": provider_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Experiences
# ---------------------------------------------------------------------------
@api.get("/experiences", response_model=List[Experience])
async def list_experiences(
    _: Annotated[User, Depends(current_user)],
    q: Optional[str] = None,
    country: Optional[str] = None,
    city: Optional[str] = None,
    type: Optional[ServiceType] = None,
    provider_id: Optional[str] = None,
    limit: int = Query(500, le=2000),
):
    import re as _re
    flt: dict = {}
    tokens = [t for t in (q or "").strip().split() if len(t) >= 2] if q else []
    if tokens:
        flt["$and"] = []
        for tok in tokens:
            safe = _re.escape(tok)
            flt["$and"].append({
                "$or": [
                    {"title": {"$regex": safe, "$options": "i"}},
                    {"description": {"$regex": safe, "$options": "i"}},
                    {"provider_name": {"$regex": safe, "$options": "i"}},
                    {"city": {"$regex": safe, "$options": "i"}},
                ]
            })
    if country:
        flt["country"] = country
    if city:
        flt["city"] = {"$regex": f"^{city}$", "$options": "i"}
    if type:
        flt["type"] = type
    if provider_id:
        flt["provider_id"] = provider_id
    items = await db.experiences.find(flt, {"_id": 0}).sort("title", 1).limit(limit).to_list(limit)
    return items


@api.post("/experiences", response_model=Experience)
async def create_experience(payload: ExperienceCreate, _: Annotated[User, Depends(current_user)]):
    prov = await db.providers.find_one({"provider_id": payload.provider_id}, {"_id": 0})
    if not prov:
        raise HTTPException(status_code=400, detail="Proveedor no encontrado")
    data = payload.model_dump()
    # Sync legacy 'price' with price_tax_incl
    if data.get("price") is None:
        data["price"] = data.get("price_tax_incl") or 0.0
    if not data.get("price_tax_incl"):
        data["price_tax_incl"] = data.get("price") or 0.0
    exp = Experience(**data, provider_name=prov["name"])
    await db.experiences.insert_one(exp.model_dump())
    return exp


@api.patch("/experiences/{experience_id}", response_model=Experience)
async def update_experience(
    experience_id: str,
    payload: ExperienceUpdate,
    _: Annotated[User, Depends(current_user)],
):
    patch = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
    if "provider_id" in patch:
        prov = await db.providers.find_one({"provider_id": patch["provider_id"]}, {"_id": 0})
        if not prov:
            raise HTTPException(status_code=400, detail="Proveedor no encontrado")
        patch["provider_name"] = prov["name"]
    # keep price tiers in sync
    if "price_tax_incl" in patch and "price" not in patch:
        patch["price"] = patch["price_tax_incl"]
    if "price" in patch and "price_tax_incl" not in patch:
        patch["price_tax_incl"] = patch["price"]
    if patch:
        await db.experiences.update_one({"experience_id": experience_id}, {"$set": patch})
    doc = await db.experiences.find_one({"experience_id": experience_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    return doc


@api.delete("/experiences/{experience_id}")
async def delete_experience(experience_id: str, _: Annotated[User, Depends(current_user)]):
    res = await db.experiences.delete_one({"experience_id": experience_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}


@api.get("/experiences/facets")
async def experience_facets(_: Annotated[User, Depends(current_user)]):
    """Return distinct values for filters."""
    countries = await db.experiences.distinct("country")
    cities = await db.experiences.distinct("city")
    types = await db.experiences.distinct("type")
    return {
        "countries": sorted([c for c in countries if c]),
        "cities": sorted([c for c in cities if c]),
        "types": sorted([t for t in types if t]),
    }


# ---------------------------------------------------------------------------
# Bulk import - provider price sheet (xlsx with columns operator_name, name, price_tax_incl/price_tax_excl, currency)
# ---------------------------------------------------------------------------
def _clean_title(s: str) -> str:
    """Strip leading numeric codes like '23 ', '25Priv', '24 SG ' that are year-tags."""
    if not s:
        return s
    s = s.strip()
    import re
    # Remove leading year-token: '23 ', '2024 ' OR '25Priv' (no space, just digits before letter)
    s = re.sub(r"^\d{2,4}(?:\s+|(?=[A-Za-z]))", "", s)
    return s.strip()


def _parse_provider_sheet_bytes(content: bytes, country: Optional[str], city: Optional[str], stype: ServiceType):
    """Parse a provider rate-sheet workbook and return list of (provider_name, exp_payload_dict)."""
    wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
    ws = wb.active

    headers_map: dict = {}
    for col in range(1, ws.max_column + 1):
        val = ws.cell(1, col).value
        if val:
            headers_map[str(val).strip().lower()] = col

    name_col = headers_map.get("name")
    op_col = headers_map.get("operator_name") or headers_map.get("operator")
    price_inc = headers_map.get("price_tax_incl")
    price_exc = headers_map.get("price_tax_excl")
    cur_col = headers_map.get("currency")

    if not name_col or not (price_inc or price_exc):
        raise ValueError("El Excel debe tener columnas 'name' y 'price_tax_incl' (o 'price_tax_excl')")

    rows = []
    for r in range(2, ws.max_row + 1):
        title = ws.cell(r, name_col).value
        if not title:
            continue
        title = _clean_title(str(title))
        if not title:
            continue
        op_name = (ws.cell(r, op_col).value if op_col else None) or "Proveedor sin nombre"
        op_name = str(op_name).strip()

        def _num(c):
            if not c:
                return 0.0
            v = ws.cell(r, c).value
            if v in (None, ""):
                return 0.0
            try:
                return float(v)
            except (TypeError, ValueError):
                return 0.0

        p_excl = _num(price_exc)
        p_incl = _num(price_inc) or p_excl

        currency = "EUR"
        if cur_col:
            v = ws.cell(r, cur_col).value
            if v:
                currency = str(v).strip() or "EUR"

        rows.append((op_name, {
            "title": title,
            "country": country,
            "city": city,
            "type": stype,
            "price_tax_excl": p_excl,
            "price_tax_incl": p_incl,
            "price": p_incl,
            "currency": currency,
        }))
    return rows


async def _import_rows(rows, dedupe: bool = True):
    """Insert experiences from parsed rows, creating providers if needed."""
    created = 0
    skipped = 0
    provider_cache: dict = {}
    for op_name, payload in rows:
        if op_name not in provider_cache:
            prov = await db.providers.find_one({"name": op_name}, {"_id": 0})
            if not prov:
                prov = Provider(name=op_name, country=payload.get("country")).model_dump()
                await db.providers.insert_one(dict(prov))
            provider_cache[op_name] = prov
        prov = provider_cache[op_name]

        if dedupe:
            existing = await db.experiences.find_one(
                {"provider_id": prov["provider_id"], "title": payload["title"], "price_tax_incl": payload["price_tax_incl"]},
                {"_id": 0},
            )
            if existing:
                skipped += 1
                continue

        exp = Experience(provider_id=prov["provider_id"], provider_name=prov["name"], **payload)
        await db.experiences.insert_one(exp.model_dump())
        created += 1
    return {"created": created, "skipped": skipped, "providers": len(provider_cache)}


@api.post("/experiences/import-provider-sheet")
async def import_provider_sheet(
    file: UploadFile = File(...),
    country: Optional[str] = None,
    city: Optional[str] = None,
    type: ServiceType = "actividad",
    _: User = Depends(current_user),
):
    """Import a provider rate sheet."""
    if not file.filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(status_code=400, detail="Sube un .xlsx")
    content = await file.read()
    try:
        rows = _parse_provider_sheet_bytes(content, country, city, type)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Excel inválido: {e}")
    result = await _import_rows(rows, dedupe=True)
    return result


@api.post("/experiences/import-all-server")
async def import_all_server(
    admin: Annotated[User, Depends(require_admin)],
    base_path: str = Query("/app/artifacts/excel_creados", description="Server-side directory to scan"),
    wipe: bool = Query(False, description="If true, wipes all experiences and providers first"),
):
    """Walk the server-side directory and import every .xlsx file found.

    Country is inferred from the parent folder containing keywords ESPA/PORT/ITAL.
    City is inferred from the first sub-folder after the country folder, skipping
    administrative folders like '2025', '2026', 'REVISADOS', etc.
    """
    import pathlib
    import re as _re

    base = pathlib.Path(base_path)
    if not base.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {base_path}")

    if wipe:
        await db.experiences.delete_many({})
        await db.providers.delete_many({})

    files = list(base.rglob("*.xlsx"))

    def infer_country_city(parts):
        country = None
        city = None
        # find country
        country_idx = None
        for i, p in enumerate(parts):
            up = p.upper()
            if "ESPA" in up and country is None:
                country = "España"
                country_idx = i
            elif "PORT" in up and country is None:
                country = "Portugal"
                country_idx = i
            elif "ITAL" in up and country is None:
                country = "Italia"
                country_idx = i
        if country_idx is not None:
            # walk subfolders after country, skip admin/year folders
            skip_pat = _re.compile(r"^(20\d{2}|REVISADOS.*|VARIOS|NUEVOS?)$", _re.IGNORECASE)
            for p in parts[country_idx + 1:-1]:  # exclude the file itself
                if skip_pat.match(p.strip()):
                    continue
                city = p.strip()
                break
        return country, city

    total_created = 0
    total_skipped = 0
    file_results = []
    for fp in files:
        country, city = infer_country_city(fp.parts)
        try:
            content = fp.read_bytes()
            rows = _parse_provider_sheet_bytes(content, country, city, "actividad")
            r = await _import_rows(rows, dedupe=True)
            total_created += r["created"]
            total_skipped += r["skipped"]
            file_results.append({"file": fp.name, "country": country, "city": city, **r})
        except Exception as e:
            file_results.append({"file": fp.name, "country": country, "city": city, "error": str(e)})
    return {
        "files_scanned": len(files),
        "total_created": total_created,
        "total_skipped": total_skipped,
        "wiped": wipe,
        "files": file_results,
    }


@api.get("/experiences/autocomplete")
async def experience_autocomplete(
    _: Annotated[User, Depends(current_user)],
    q: str = Query("", min_length=0),
    city: Optional[str] = None,
    country: Optional[str] = None,
    type: Optional[ServiceType] = None,
    limit: int = Query(20, le=50),
):
    """Smart typeahead: tokenized AND-search on title + provider_name.

    Each whitespace-separated token in `q` must appear in title OR provider_name
    (case-insensitive). Optional pre-filters: city, country, type.
    """
    import re as _re
    flt: dict = {}
    tokens = [t for t in (q or "").strip().split() if len(t) >= 2]
    if tokens:
        flt["$and"] = []
        for tok in tokens:
            safe = _re.escape(tok)
            flt["$and"].append({
                "$or": [
                    {"title": {"$regex": safe, "$options": "i"}},
                    {"provider_name": {"$regex": safe, "$options": "i"}},
                ]
            })
    if city:
        flt["city"] = {"$regex": f"^{city}$", "$options": "i"}
    if country:
        flt["country"] = country
    if type:
        flt["type"] = type
    proj = {"_id": 0, "experience_id": 1, "title": 1, "provider_name": 1, "city": 1, "country": 1,
            "type": 1, "price_tax_excl": 1, "price_tax_incl": 1, "price": 1, "currency": 1}
    items = await db.experiences.find(flt, proj).sort("title", 1).limit(limit).to_list(limit)
    return items


@api.get("/experiences/import-all-status")
async def import_all_status(_: Annotated[User, Depends(require_admin)]):
    """Quick stats for the admin panel."""
    return {
        "providers": await db.providers.count_documents({}),
        "experiences": await db.experiences.count_documents({}),
    }


# ---------------------------------------------------------------------------
# Itineraries
# ---------------------------------------------------------------------------
@api.get("/itineraries", response_model=List[Itinerary])
async def list_itineraries(
    user: Annotated[User, Depends(current_user)],
    agent: Optional[str] = None,
    traveler: Optional[str] = None,
):
    """Agents see only their own itineraries.
    Admins see everything and can filter by agent (created_by email) or traveler name.
    """
    flt: dict = {}
    if user.role == "admin":
        if agent:
            flt["created_by"] = agent
        if traveler:
            flt["main_traveler"] = {"$regex": traveler, "$options": "i"}
    else:
        flt["created_by"] = user.email
        if traveler:
            flt["main_traveler"] = {"$regex": traveler, "$options": "i"}
    items = await db.itineraries.find(flt, {"_id": 0}).sort("updated_at", -1).to_list(500)
    return items


@api.get("/itineraries/agents")
async def list_itinerary_agents(user: Annotated[User, Depends(current_user)]):
    """Distinct list of agents who have created itineraries (admin-only)."""
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    emails = await db.itineraries.distinct("created_by")
    return {"agents": sorted([e for e in emails if e])}


@api.post("/itineraries", response_model=Itinerary)
async def create_itinerary(payload: ItineraryUpsert, user: Annotated[User, Depends(current_user)]):
    data = payload.model_dump(exclude_unset=True)
    itn = Itinerary(**data, created_by=user.email)
    itn.updated_at = now_iso()
    await db.itineraries.insert_one(itn.model_dump())
    return itn


def _can_access(itn_doc: dict, user: User) -> bool:
    if user.role == "admin":
        return True
    return itn_doc.get("created_by") == user.email


@api.get("/itineraries/{itinerary_id}", response_model=Itinerary)
async def get_itinerary(itinerary_id: str, user: Annotated[User, Depends(current_user)]):
    doc = await db.itineraries.find_one({"itinerary_id": itinerary_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    if not _can_access(doc, user):
        raise HTTPException(status_code=403, detail="No tienes acceso a este itinerario")
    return doc


@api.patch("/itineraries/{itinerary_id}", response_model=Itinerary)
async def update_itinerary(
    itinerary_id: str,
    payload: ItineraryUpsert,
    user: Annotated[User, Depends(current_user)],
):
    doc = await db.itineraries.find_one({"itinerary_id": itinerary_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    if not _can_access(doc, user):
        raise HTTPException(status_code=403, detail="No tienes acceso a este itinerario")
    patch = payload.model_dump(exclude_unset=True)
    patch["updated_at"] = now_iso()
    await db.itineraries.update_one({"itinerary_id": itinerary_id}, {"$set": patch})
    doc = await db.itineraries.find_one({"itinerary_id": itinerary_id}, {"_id": 0})
    return doc


@api.delete("/itineraries/{itinerary_id}")
async def delete_itinerary(itinerary_id: str, user: Annotated[User, Depends(current_user)]):
    doc = await db.itineraries.find_one({"itinerary_id": itinerary_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    if not _can_access(doc, user):
        raise HTTPException(status_code=403, detail="No tienes acceso a este itinerario")
    await db.itineraries.delete_one({"itinerary_id": itinerary_id})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Excel export (Sofi format)
# ---------------------------------------------------------------------------
def _fmt_date(s: Optional[str]) -> str:
    if not s:
        return ""
    try:
        return datetime.fromisoformat(s).strftime("%d/%m/%Y")
    except (TypeError, ValueError):
        return s


@api.get("/itineraries/{itinerary_id}/export")
async def export_itinerary(itinerary_id: str, user: Annotated[User, Depends(current_user)]):
    itn_doc = await db.itineraries.find_one({"itinerary_id": itinerary_id}, {"_id": 0})
    if not itn_doc:
        raise HTTPException(status_code=404, detail="Not found")
    if not _can_access(itn_doc, user):
        raise HTTPException(status_code=403, detail="No tienes acceso a este itinerario")
    itn = Itinerary(**itn_doc)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Trip Prices"

    bold = Font(bold=True)
    header_fill = PatternFill(start_color="F5F2EB", end_color="F5F2EB", fill_type="solid")
    section_fill = PatternFill(start_color="E07A5F", end_color="E07A5F", fill_type="solid")
    section_font = Font(bold=True, color="FFFFFF")
    thin = Side(border_style="thin", color="E8E3D9")
    box = Border(left=thin, right=thin, top=thin, bottom=thin)

    def label(row, value):
        ws.cell(row, 1, "Main traveler name" if row == 1 else value)

    ws.cell(1, 1, "Main traveler name").font = bold
    ws.cell(1, 2, itn.main_traveler)
    ws.cell(2, 1, "Trip start date").font = bold
    ws.cell(2, 2, _fmt_date(itn.start_date))
    ws.cell(3, 1, "Trip end date").font = bold
    ws.cell(3, 2, _fmt_date(itn.end_date))
    ws.cell(4, 1, "Duration (days)").font = bold
    ws.cell(4, 2, itn.duration_days)
    ws.cell(5, 1, "Number of travelers").font = bold
    ws.cell(5, 2, itn.num_travelers)

    # Traveler details
    ws.cell(9, 1, "Traveler Details").font = section_font
    ws.cell(9, 1).fill = section_fill
    ws.cell(10, 1, "First name").font = bold
    ws.cell(10, 2, "Last name").font = bold
    ws.cell(10, 1).fill = header_fill
    ws.cell(10, 2).fill = header_fill
    row = 11
    for t in itn.travelers or []:
        ws.cell(row, 1, t.first_name)
        ws.cell(row, 2, t.last_name)
        row += 1
    if not itn.travelers:
        row = 12  # leave space

    # Activities & transportation
    ws.cell(14, 1, "Activities and transportation").font = section_font
    ws.cell(14, 1).fill = section_fill
    head_row = 15
    headers = ["Day", "Date", "City", "Type", "Name", "Quantity", "Precio sin IVA", "Precio con IVA", "PVP"]
    for i, h in enumerate(headers, start=1):
        c = ws.cell(head_row, i, h)
        c.font = bold
        c.fill = header_fill
        c.border = box

    mk = (itn.markup_pct or 0) / 100.0
    r = head_row + 1
    activities_excl = 0.0
    activities_incl = 0.0
    for idx, day in enumerate(itn.days or [], start=1):
        ws.cell(r, 1, f"Day {idx}").font = bold
        ws.cell(r, 2, _fmt_date(day.date))
        ws.cell(r, 3, day.city or "")
        for col_i in range(1, len(headers) + 1):
            ws.cell(r, col_i).fill = header_fill
        r += 1
        for s in day.services:
            ws.cell(r, 4, s.type)
            ws.cell(r, 5, s.name)
            ws.cell(r, 6, s.quantity)
            unit_excl = s.unit_price_tax_excl or 0
            unit_incl = s.unit_price_tax_incl or s.unit_price or 0
            line_excl = unit_excl * (s.quantity or 0)
            line_incl = unit_incl * (s.quantity or 0)
            line_pvp = line_incl * (1 + mk)
            ws.cell(r, 7, round(line_excl, 2))
            ws.cell(r, 8, round(line_incl, 2))
            ws.cell(r, 9, round(line_pvp, 2))
            activities_excl += line_excl
            activities_incl += line_incl
            r += 1

    # Accommodations
    acc_section = r + 1
    ws.cell(acc_section, 1, "Accommodations").font = section_font
    ws.cell(acc_section, 1).fill = section_fill
    acc_head = acc_section + 1
    acc_headers = ["", "Date", "Name", "", "Currency", "", "Precio sin IVA", "Precio con IVA", "PVP"]
    for i, h in enumerate(acc_headers, start=1):
        c = ws.cell(acc_head, i, h)
        c.font = bold
        c.fill = header_fill
    r2 = acc_head + 1
    acc_excl = 0.0
    acc_incl = 0.0
    for a in itn.accommodations or []:
        date_range = f"{_fmt_date(a.date_from)} - {_fmt_date(a.date_to)}"
        ws.cell(r2, 2, date_range)
        ws.cell(r2, 3, a.name)
        ws.cell(r2, 5, a.currency)
        p_excl = a.price_tax_excl or 0
        p_incl = a.price_tax_incl or a.price or 0
        ws.cell(r2, 7, round(p_excl, 2))
        ws.cell(r2, 8, round(p_incl, 2))
        ws.cell(r2, 9, round(p_incl * (1 + mk), 2))
        acc_excl += p_excl
        acc_incl += p_incl
        r2 += 1

    # Totals
    total_row = r2 + 2
    sub_excl = activities_excl + acc_excl
    sub_incl = activities_incl + acc_incl
    pvp = sub_incl * (1 + mk)
    ws.cell(total_row, 6, "Subtotal sin IVA").font = bold
    ws.cell(total_row, 7, round(sub_excl, 2))
    ws.cell(total_row + 1, 6, "Subtotal con IVA").font = bold
    ws.cell(total_row + 1, 8, round(sub_incl, 2))
    ws.cell(total_row + 2, 6, f"PVP (markup {itn.markup_pct or 0}% sobre IVA)").font = bold
    ws.cell(total_row + 2, 9, round(pvp, 2))
    for col_i in range(6, 10):
        ws.cell(total_row + 2, col_i).fill = section_fill
        ws.cell(total_row + 2, col_i).font = section_font

    # Column widths
    widths = [10, 14, 14, 16, 50, 10, 14, 14, 14]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = w

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    safe_name = "".join(c for c in (itn.name or "itinerary") if c.isalnum() or c in "-_ ").strip() or "itinerary"
    filename = f"{safe_name}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@api.get("/")
async def root():
    return {"ok": True, "service": "itinerary-builder"}


@api.get("/stats")
async def stats(_: Annotated[User, Depends(current_user)]):
    return {
        "providers": await db.providers.count_documents({}),
        "experiences": await db.experiences.count_documents({}),
        "itineraries": await db.itineraries.count_documents({}),
        "users": await db.users.count_documents({}),
        "hotels": await db.hotels.count_documents({}),
        "training_examples": await db.training_examples.count_documents({}),
    }


# ===========================================================================
# Hotels library (separate from experiences)
# ===========================================================================
HotelTier = Literal["luxury", "upscale", "comfort", "standard", "budget"]


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


@api.get("/hotels", response_model=List[Hotel])
async def list_hotels(
    _: Annotated[User, Depends(current_user)],
    q: Optional[str] = None,
    city: Optional[str] = None,
    country: Optional[str] = None,
    tier: Optional[HotelTier] = None,
):
    flt: dict = {}
    if q:
        flt["$or"] = [
            {"name": {"$regex": q, "$options": "i"}},
            {"city": {"$regex": q, "$options": "i"}},
            {"description": {"$regex": q, "$options": "i"}},
        ]
    if city:
        flt["city"] = {"$regex": f"^{city}$", "$options": "i"}
    if country:
        flt["country"] = country
    if tier:
        flt["tier"] = tier
    items = await db.hotels.find(flt, {"_id": 0}).sort("name", 1).to_list(2000)
    return items


@api.post("/hotels", response_model=Hotel)
async def create_hotel(payload: HotelCreate, _: Annotated[User, Depends(current_user)]):
    h = Hotel(**payload.model_dump())
    await db.hotels.insert_one(h.model_dump())
    return h


@api.patch("/hotels/{hotel_id}", response_model=Hotel)
async def update_hotel(hotel_id: str, payload: HotelUpdate, _: Annotated[User, Depends(current_user)]):
    patch = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
    if patch:
        await db.hotels.update_one({"hotel_id": hotel_id}, {"$set": patch})
    doc = await db.hotels.find_one({"hotel_id": hotel_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    return doc


@api.delete("/hotels/{hotel_id}")
async def delete_hotel(hotel_id: str, _: Annotated[User, Depends(current_user)]):
    res = await db.hotels.delete_one({"hotel_id": hotel_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}


# ===========================================================================
# AI Trainer: Training examples
# ===========================================================================
TripOutcome = Literal["sold", "not_sold", "pending"]


class TrainingExample(BaseModel):
    model_config = ConfigDict(extra="ignore")
    example_id: str = Field(default_factory=lambda: new_id("trn"))
    client_name: Optional[str] = None
    client_request: str
    itinerary_url: Optional[str] = None
    itinerary_text: Optional[str] = None  # scraped / pasted
    outcome: TripOutcome = "pending"
    notes: Optional[str] = None
    created_by: Optional[str] = None
    created_at: str = Field(default_factory=now_iso)


class TrainingExampleUpsert(BaseModel):
    client_name: Optional[str] = None
    client_request: Optional[str] = None
    itinerary_url: Optional[str] = None
    itinerary_text: Optional[str] = None
    outcome: Optional[TripOutcome] = None
    notes: Optional[str] = None


@api.get("/training-examples", response_model=List[TrainingExample])
async def list_training_examples(_: Annotated[User, Depends(current_user)]):
    items = await db.training_examples.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return items


@api.post("/training-examples", response_model=TrainingExample)
async def create_training_example(
    payload: TrainingExampleUpsert,
    user: Annotated[User, Depends(current_user)],
):
    if not payload.client_request:
        raise HTTPException(status_code=400, detail="client_request es obligatorio")
    ex = TrainingExample(
        client_name=payload.client_name,
        client_request=payload.client_request,
        itinerary_url=payload.itinerary_url,
        itinerary_text=payload.itinerary_text,
        outcome=payload.outcome or "pending",
        notes=payload.notes,
        created_by=user.email,
    )
    await db.training_examples.insert_one(ex.model_dump())
    return ex


@api.patch("/training-examples/{example_id}", response_model=TrainingExample)
async def update_training_example(
    example_id: str,
    payload: TrainingExampleUpsert,
    _: Annotated[User, Depends(current_user)],
):
    patch = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
    if patch:
        await db.training_examples.update_one({"example_id": example_id}, {"$set": patch})
    doc = await db.training_examples.find_one({"example_id": example_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    return doc


@api.delete("/training-examples/{example_id}")
async def delete_training_example(example_id: str, _: Annotated[User, Depends(current_user)]):
    res = await db.training_examples.delete_one({"example_id": example_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}


@api.post("/training-examples/scrape")
async def scrape_itinerary_url(
    payload: dict = Body(...),
    _: User = Depends(current_user),
):
    """Fetch a URL and return cleaned text content.

    Handles two known sources:
    - Public URLs (travefy.com, etc.) — anonymous fetch.
    - gestion.viajadverdad.com — uses stored agent credentials (env vars).
    Returns {"text": "...", "ok": bool, "source": "anonymous"|"gestion"|"failed"}.
    """
    url = (payload.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL es obligatoria")

    text = ""
    source = "anonymous"
    ok = False
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as http:
            if "gestion.viajadverdad.com" in url:
                user_g = os.environ.get("GESTION_VIAJADVERDAD_USER")
                pass_g = os.environ.get("GESTION_VIAJADVERDAD_PASS")
                source = "gestion"
                if user_g and pass_g:
                    # Best-effort form login: try posting to /login
                    try:
                        await http.post(
                            "https://gestion.viajadverdad.com/login",
                            data={"username": user_g, "password": pass_g, "email": user_g},
                        )
                    except Exception:
                        pass
                r = await http.get(url)
            else:
                r = await http.get(url, headers={"User-Agent": "Mozilla/5.0 ItineraryBot"})
            if r.status_code == 200:
                soup = BeautifulSoup(r.text, "lxml")
                for tag in soup(["script", "style", "noscript", "iframe"]):
                    tag.decompose()
                text = soup.get_text("\n", strip=True)
                # Compact whitespace
                lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
                text = "\n".join(lines)[:20000]
                ok = bool(text and len(text) > 50)
    except Exception as e:
        logger.warning("scrape error: %s", e)
        source = "failed"

    return {"ok": ok, "source": source, "text": text}


# ===========================================================================
# AI generation
# ===========================================================================
EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")


SYSTEM_PROMPT_GENERATE = """You are an expert travel-itinerary designer for a Spanish luxury-travel agency.

You build itineraries for the destinations Spain, Portugal and Italy. You work in English.

You will be given:
1) A new client trip request.
2) A library of available EXPERIENCES (curated activities + transport with real prices) that you MUST pick from when possible.
3) A library of HOTELS (with tier + price) that you MUST pick from for accommodations when possible.
4) A set of PAST EXAMPLES tagged "sold" (the itinerary the client accepted) and "not_sold" (the itinerary the client rejected). Learn the patterns: pacing, daily density, hotel tier choices, kinds of activities, regional flow.

Your output MUST be a single JSON object matching exactly this schema (no markdown, no commentary):
{
  "name": "...",                   // short trip name in English
  "main_traveler": "...",          // primary traveler name if mentioned, else ""
  "num_travelers": 2,
  "start_date": "YYYY-MM-DD",      // best guess from request
  "end_date": "YYYY-MM-DD",
  "markup_pct": 15,                // leave default 15 unless request suggests otherwise
  "summary": "1-3 sentence rationale referencing past sold patterns",
  "days": [
    {
      "label": "Day 1",
      "date": "YYYY-MM-DD",
      "city": "Lisbon",
      "services": [
        {
          "experience_id": "exp_xxx",   // REQUIRED if picked from library
          "type": "actividad",          // one of: alojamiento, actividad, transporte, restaurante, transfer, vuelo, otro
          "name": "Tile museum private tour",
          "provider_name": "Provider X",
          "quantity": 2,
          "unit_price_tax_excl": 100.0,
          "unit_price_tax_incl": 121.0,
          "currency": "EUR"
        }
      ]
    }
  ],
  "accommodations": [
    {
      "hotel_id": "htl_xxx",          // REQUIRED if picked from hotel library
      "name": "Bairro Alto Hotel",
      "date_from": "YYYY-MM-DD",
      "date_to": "YYYY-MM-DD",
      "price_tax_excl": 0,
      "price_tax_incl": 0,
      "currency": "EUR"
    }
  ]
}

Rules:
- ALWAYS prefer experiences from the library. Use their experience_id, exact title, provider_name, currency, and BOTH prices unchanged.
- ALWAYS prefer hotels from the library. Use their hotel_id, exact name, and the nightly price multiplied by nights, splitting excl/incl.
- If a needed service or hotel is not in the library, you may add a free-form item with name only and prices=0, so the human agent can fill it in.
- Respect dietary, mobility, occasion (anniversary etc.) and tier preferences expressed in the request.
- Aim for the pacing seen in SOLD examples; avoid the over-/under-packing patterns of NOT_SOLD examples.
- Distribute activities sensibly across days. 1-3 services per day is typical.
- Output ONLY the JSON object. No prose before or after."""


async def _call_claude_json(system_prompt: str, user_prompt: str) -> dict:
    """Call Claude Sonnet 4.6 and parse JSON output."""
    import json as _json
    from emergentintegrations.llm.chat import LlmChat, UserMessage

    if not EMERGENT_LLM_KEY:
        raise HTTPException(status_code=500, detail="EMERGENT_LLM_KEY no configurada")

    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=f"gen-{uuid.uuid4().hex[:8]}",
        system_message=system_prompt,
    ).with_model("anthropic", "claude-sonnet-4-6")
    msg = UserMessage(text=user_prompt)
    raw = await chat.send_message(msg)
    text = (raw or "").strip()
    # Strip optional markdown fences
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    # Try to locate first JSON object
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        raise HTTPException(status_code=502, detail=f"AI no devolvió JSON: {text[:200]}")
    try:
        return _json.loads(text[start:end + 1])
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"JSON inválido del modelo: {e}")


def _summ_experience(e: dict) -> dict:
    return {
        "experience_id": e.get("experience_id"),
        "title": e.get("title"),
        "provider_name": e.get("provider_name"),
        "city": e.get("city"),
        "country": e.get("country"),
        "type": e.get("type"),
        "price_tax_excl": e.get("price_tax_excl") or e.get("price") or 0,
        "price_tax_incl": e.get("price_tax_incl") or e.get("price") or 0,
        "currency": e.get("currency") or "EUR",
    }


def _summ_hotel(h: dict) -> dict:
    return {
        "hotel_id": h.get("hotel_id"),
        "name": h.get("name"),
        "city": h.get("city"),
        "country": h.get("country"),
        "tier": h.get("tier"),
        "price_per_night_excl": h.get("price_per_night_excl") or 0,
        "price_per_night_incl": h.get("price_per_night_incl") or 0,
        "currency": h.get("currency") or "EUR",
    }


@api.post("/ai/generate-itinerary")
async def ai_generate(
    payload: dict = Body(...),
    user: User = Depends(current_user),
):
    """Generate an itinerary draft from a client request.

    payload = {"client_request": "...", "client_name": "...optional", "save": true}
    Returns the parsed JSON. If save=true (default), also stores it as an Itinerary draft.
    """
    request_text = (payload.get("client_request") or "").strip()
    if not request_text:
        raise HTTPException(status_code=400, detail="client_request es obligatorio")
    client_name = (payload.get("client_name") or "").strip()
    save = bool(payload.get("save", True))

    # Build context: library subsets and training examples
    # 1) Pull relevant experiences (limit by tokens). We pass a focused subset
    #    inferred by simple keyword matching from the request.
    keywords = {w.lower() for w in request_text.split() if len(w) > 4}
    # First pass: try to fetch experiences whose city/title matches keywords
    exp_flt: dict = {}
    if keywords:
        terms = list(keywords)[:25]
        exp_flt["$or"] = [
            {"title": {"$regex": "|".join(map(_re_escape, terms)), "$options": "i"}},
            {"city": {"$regex": "|".join(map(_re_escape, terms)), "$options": "i"}},
        ]
    exps = await db.experiences.find(exp_flt, {"_id": 0}).limit(200).to_list(200)
    if len(exps) < 30:
        # widen
        more = await db.experiences.find({}, {"_id": 0}).limit(150).to_list(150)
        seen = {e["experience_id"] for e in exps}
        for e in more:
            if e["experience_id"] not in seen:
                exps.append(e)
                if len(exps) >= 200:
                    break

    hotels = await db.hotels.find({}, {"_id": 0}).limit(150).to_list(150)
    examples = await db.training_examples.find(
        {"itinerary_text": {"$ne": None}, "outcome": {"$in": ["sold", "not_sold"]}},
        {"_id": 0},
    ).sort("created_at", -1).limit(20).to_list(20)

    user_prompt_parts = [
        f"NEW CLIENT REQUEST:\n{request_text}",
        "",
        "EXPERIENCE LIBRARY (pick from these whenever possible):",
        _compact_json([_summ_experience(e) for e in exps]),
        "",
        "HOTEL LIBRARY (pick from these for accommodations):",
        _compact_json([_summ_hotel(h) for h in hotels]),
        "",
    ]
    if examples:
        user_prompt_parts.append("PAST EXAMPLES (learn from these patterns):")
        for ex in examples:
            user_prompt_parts.append(
                f"--- outcome={ex['outcome']} ---\n"
                f"CLIENT REQUEST:\n{ex['client_request'][:1500]}\n\n"
                f"FINAL ITINERARY:\n{(ex.get('itinerary_text') or '')[:3000]}\n"
            )
    user_prompt_parts.append("\nNow produce ONLY the JSON itinerary for the NEW CLIENT REQUEST above.")

    data = await _call_claude_json(SYSTEM_PROMPT_GENERATE, "\n".join(user_prompt_parts))

    # Build itinerary draft from AI output
    draft = _itinerary_from_ai(data, client_name or data.get("main_traveler", ""), user.email)
    if save:
        await db.itineraries.insert_one(dict(draft))  # avoid mutating draft with _id
    draft.pop("_id", None)
    return {"itinerary": draft, "ai_summary": data.get("summary", "")}


def _re_escape(s: str) -> str:
    import re
    return re.escape(s)


def _compact_json(obj) -> str:
    import json as _json
    return _json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _itinerary_from_ai(data: dict, client_name: str, created_by: str) -> dict:
    """Map AI JSON to our Itinerary schema, generating IDs and syncing legacy fields."""
    name = data.get("name") or "AI draft"
    days_in = data.get("days") or []
    days = []
    for d in days_in:
        services = []
        for s in d.get("services") or []:
            excl = float(s.get("unit_price_tax_excl") or 0)
            incl = float(s.get("unit_price_tax_incl") or 0)
            services.append({
                "service_id": new_id("svc"),
                "experience_id": s.get("experience_id"),
                "type": s.get("type") or "actividad",
                "name": s.get("name") or "",
                "provider_name": s.get("provider_name") or "",
                "quantity": float(s.get("quantity") or 1),
                "unit_price_tax_excl": excl,
                "unit_price_tax_incl": incl,
                "unit_price": incl,
                "currency": s.get("currency") or "EUR",
            })
        days.append({
            "day_id": new_id("day"),
            "date": d.get("date"),
            "label": d.get("label") or "Day",
            "city": d.get("city") or "",
            "services": services,
        })
    accs = []
    for a in data.get("accommodations") or []:
        incl = float(a.get("price_tax_incl") or 0)
        excl = float(a.get("price_tax_excl") or 0)
        accs.append({
            "acc_id": new_id("acc"),
            "date_from": a.get("date_from"),
            "date_to": a.get("date_to"),
            "name": a.get("name") or "",
            "price_tax_excl": excl,
            "price_tax_incl": incl,
            "price": incl,
            "currency": a.get("currency") or "EUR",
        })

    itn = {
        "itinerary_id": new_id("itn"),
        "name": name,
        "main_traveler": client_name or data.get("main_traveler") or "",
        "start_date": data.get("start_date"),
        "end_date": data.get("end_date"),
        "duration_days": len(days),
        "num_travelers": int(data.get("num_travelers") or 2),
        "travelers": [],
        "days": days,
        "accommodations": accs,
        "markup_pct": float(data.get("markup_pct") or 15),
        "currency": "EUR",
        "status": "draft",
        "created_by": created_by,
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "ai_generated": True,
        "ai_summary": data.get("summary", ""),
    }
    return itn


# ---------------------------------------------------------------------------
# Mount router and CORS
# ---------------------------------------------------------------------------
app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origin_regex=".*",
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)
