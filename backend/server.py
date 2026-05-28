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
    price: float = 0.0
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
    price: float = 0.0
    currency: str = "EUR"
    notes: Optional[str] = None


class ExperienceUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    provider_id: Optional[str] = None
    country: Optional[str] = None
    city: Optional[str] = None
    type: Optional[ServiceType] = None
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
    unit_price: float = 0.0
    currency: str = "EUR"
    notes: Optional[str] = None


class ItineraryDay(BaseModel):
    day_id: str = Field(default_factory=lambda: new_id("day"))
    date: Optional[str] = None  # ISO date string
    label: Optional[str] = None  # e.g. "Day 1"
    services: List[ItineraryService] = Field(default_factory=list)


class Accommodation(BaseModel):
    acc_id: str = Field(default_factory=lambda: new_id("acc"))
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    name: str
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
    flt: dict = {}
    if q:
        flt["$or"] = [
            {"title": {"$regex": q, "$options": "i"}},
            {"description": {"$regex": q, "$options": "i"}},
            {"provider_name": {"$regex": q, "$options": "i"}},
        ]
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
    exp = Experience(**payload.model_dump(), provider_name=prov["name"])
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
@api.post("/experiences/import-provider-sheet")
async def import_provider_sheet(
    file: UploadFile = File(...),
    country: Optional[str] = None,
    city: Optional[str] = None,
    type: ServiceType = "actividad",
    _: User = Depends(current_user),
):
    """Import a provider rate sheet. Expected columns (case insensitive):
    operator_name, name, price_tax_incl OR price_tax_excl, currency.
    Creates the provider if it doesn't exist. Each row becomes an experience.
    """
    if not file.filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(status_code=400, detail="Sube un .xlsx")
    content = await file.read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Excel inválido: {e}")
    ws = wb.active

    headers_map = {}
    for col in range(1, ws.max_column + 1):
        val = ws.cell(1, col).value
        if val:
            headers_map[str(val).strip().lower()] = col

    def col(name):
        return headers_map.get(name)

    name_col = col("name")
    op_col = col("operator_name") or col("operator")
    price_inc = col("price_tax_incl")
    price_exc = col("price_tax_excl")
    cur_col = col("currency")

    if not name_col or not (price_inc or price_exc):
        raise HTTPException(
            status_code=400,
            detail="El Excel debe tener columnas 'name' y 'price_tax_incl' (o 'price_tax_excl')",
        )

    provider_cache: dict = {}
    created = 0
    for r in range(2, ws.max_row + 1):
        title = ws.cell(r, name_col).value
        if not title:
            continue
        title = str(title).strip()
        op_name = (ws.cell(r, op_col).value if op_col else None) or "Proveedor sin nombre"
        op_name = str(op_name).strip()
        if op_name not in provider_cache:
            prov = await db.providers.find_one({"name": op_name}, {"_id": 0})
            if not prov:
                prov = Provider(name=op_name, country=country).model_dump()
                await db.providers.insert_one(dict(prov))
            provider_cache[op_name] = prov

        prov = provider_cache[op_name]

        price = 0.0
        for c in (price_inc, price_exc):
            if c:
                v = ws.cell(r, c).value
                if v not in (None, ""):
                    try:
                        price = float(v)
                        break
                    except (TypeError, ValueError):
                        continue
        currency = "EUR"
        if cur_col:
            v = ws.cell(r, cur_col).value
            if v:
                currency = str(v).strip() or "EUR"

        exp = Experience(
            title=title,
            provider_id=prov["provider_id"],
            provider_name=prov["name"],
            country=country,
            city=city,
            type=type,
            price=price,
            currency=currency,
        )
        await db.experiences.insert_one(exp.model_dump())
        created += 1

    return {"created": created, "providers": len(provider_cache)}


# ---------------------------------------------------------------------------
# Itineraries
# ---------------------------------------------------------------------------
@api.get("/itineraries", response_model=List[Itinerary])
async def list_itineraries(user: Annotated[User, Depends(current_user)]):
    items = await db.itineraries.find({}, {"_id": 0}).sort("updated_at", -1).to_list(500)
    return items


@api.post("/itineraries", response_model=Itinerary)
async def create_itinerary(payload: ItineraryUpsert, user: Annotated[User, Depends(current_user)]):
    data = payload.model_dump(exclude_unset=True)
    itn = Itinerary(**data, created_by=user.email)
    itn.updated_at = now_iso()
    await db.itineraries.insert_one(itn.model_dump())
    return itn


@api.get("/itineraries/{itinerary_id}", response_model=Itinerary)
async def get_itinerary(itinerary_id: str, _: Annotated[User, Depends(current_user)]):
    doc = await db.itineraries.find_one({"itinerary_id": itinerary_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    return doc


@api.patch("/itineraries/{itinerary_id}", response_model=Itinerary)
async def update_itinerary(
    itinerary_id: str,
    payload: ItineraryUpsert,
    _: Annotated[User, Depends(current_user)],
):
    patch = payload.model_dump(exclude_unset=True)
    patch["updated_at"] = now_iso()
    res = await db.itineraries.update_one({"itinerary_id": itinerary_id}, {"$set": patch})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    doc = await db.itineraries.find_one({"itinerary_id": itinerary_id}, {"_id": 0})
    return doc


@api.delete("/itineraries/{itinerary_id}")
async def delete_itinerary(itinerary_id: str, _: Annotated[User, Depends(current_user)]):
    res = await db.itineraries.delete_one({"itinerary_id": itinerary_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
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
async def export_itinerary(itinerary_id: str, _: Annotated[User, Depends(current_user)]):
    itn_doc = await db.itineraries.find_one({"itinerary_id": itinerary_id}, {"_id": 0})
    if not itn_doc:
        raise HTTPException(status_code=404, detail="Not found")
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
    headers = ["Day", "Date", "", "Type", "Name", "Quantity", "Price"]
    for i, h in enumerate(headers, start=1):
        c = ws.cell(head_row, i, h)
        c.font = bold
        c.fill = header_fill
        c.border = box

    r = head_row + 1
    activities_total = 0.0
    for idx, day in enumerate(itn.days or [], start=1):
        ws.cell(r, 1, f"Day {idx}").font = bold
        ws.cell(r, 2, _fmt_date(day.date))
        for col_i in range(1, 8):
            ws.cell(r, col_i).fill = header_fill
        r += 1
        for s in day.services:
            ws.cell(r, 4, s.type)
            ws.cell(r, 5, s.name)
            ws.cell(r, 6, s.quantity)
            line_total = (s.unit_price or 0) * (s.quantity or 0)
            ws.cell(r, 7, line_total)
            activities_total += line_total
            r += 1

    # Accommodations
    acc_section = r + 1
    ws.cell(acc_section, 1, "Accommodations").font = section_font
    ws.cell(acc_section, 1).fill = section_fill
    acc_head = acc_section + 1
    acc_headers = ["Day", "Date", "Name", "", "Price", "Currency"]
    for i, h in enumerate(acc_headers, start=1):
        c = ws.cell(acc_head, i, h)
        c.font = bold
        c.fill = header_fill
    r2 = acc_head + 1
    acc_total = 0.0
    for a in itn.accommodations or []:
        date_range = f"{_fmt_date(a.date_from)} - {_fmt_date(a.date_to)}"
        ws.cell(r2, 2, date_range)
        ws.cell(r2, 3, a.name)
        ws.cell(r2, 5, a.price)
        ws.cell(r2, 6, a.currency)
        acc_total += a.price or 0
        r2 += 1

    # Totals
    total_row = r2 + 2
    subtotal = activities_total + acc_total
    markup_amount = subtotal * (itn.markup_pct or 0) / 100.0
    final_price = subtotal + markup_amount
    ws.cell(total_row, 4, "Subtotal").font = bold
    ws.cell(total_row, 7, subtotal)
    ws.cell(total_row + 1, 4, f"Markup ({itn.markup_pct or 0}%)").font = bold
    ws.cell(total_row + 1, 7, markup_amount)
    ws.cell(total_row + 2, 4, "Final price").font = bold
    ws.cell(total_row + 2, 7, final_price)
    ws.cell(total_row + 2, 4).fill = section_fill
    ws.cell(total_row + 2, 4).font = section_font
    ws.cell(total_row + 2, 7).fill = section_fill
    ws.cell(total_row + 2, 7).font = section_font

    # Column widths
    widths = [14, 14, 4, 18, 50, 12, 14]
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
    }


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
