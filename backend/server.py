"""
Travel Itinerary Builder - FastAPI backend.

Stack: FastAPI + Motor (MongoDB) + Emergent-managed Google Auth.
All routes are mounted under /api.
"""
from __future__ import annotations

import asyncio
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

# Local imports
from retrieval import bump_version, get_retriever

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


@app.on_event("startup")
async def ensure_playwright_browser():
    """Pods sometimes lose the Playwright Chromium binary after image recycling.
    Run `playwright install chromium` on every startup — it's idempotent and
    only downloads the version the *current* SDK requires (older 1208/1223
    folders may exist but be unusable after an SDK upgrade)."""
    logger.info("Verifying Playwright browser is up-to-date…")
    try:
        proc = await asyncio.create_subprocess_exec(
            "playwright", "install", "chromium",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            stdout_bytes, _ = await asyncio.wait_for(proc.communicate(), timeout=180)
            tail = stdout_bytes.decode(errors="ignore")[-300:].strip()
            if proc.returncode == 0:
                logger.info("Playwright browser ready · %s", tail.splitlines()[-1] if tail else "ok")
            else:
                logger.error("playwright install exit=%s · %s", proc.returncode, tail)
        except asyncio.TimeoutError:
            proc.kill()
            logger.error("playwright install timed out after 180s")
    except Exception as e:
        logger.error("Could not auto-install Playwright browser: %s", e)


@app.on_event("startup")
async def reap_orphan_bulk_jobs():
    """Any bulk_import_job left as queued/running from a previous process is
    orphaned — the in-memory asyncio task died with the restart. Mark them
    `interrupted` so the AI Trainer UI shows what really happened instead of
    spinning forever on a job that no one is processing."""
    try:
        res = await db.bulk_import_jobs.update_many(
            {"status": {"$in": ["queued", "running"]}},
            {"$set": {
                "status": "interrupted",
                "finished_at": now_iso(),
                "last_message": "Job interrumpido por reinicio del backend. Pulsa 'Reanudar' para continuar desde donde quedó (los viajes ya importados no se vuelven a procesar).",
            }},
        )
        if res.modified_count:
            logger.warning("Marked %d orphan bulk-import job(s) as interrupted", res.modified_count)
    except Exception as e:
        logger.warning("orphan bulk-job reaper failed: %s", e)


@app.on_event("startup")
async def auto_resume_interrupted_jobs():
    """After the orphan reaper runs, kick off a background watcher that auto-resumes
    any interrupted job which still has unprocessed trips. Survives sleep/restart
    of the backend so long-running imports always reach completion."""
    async def _watcher():
        # Initial small delay so the rest of startup can finish.
        await asyncio.sleep(8)
        while True:
            try:
                cursor = db.bulk_import_jobs.find(
                    {"status": "interrupted"},
                    {"_id": 0, "job_id": 1, "params": 1, "pending_trip_ids": 1,
                     "processed_trip_ids": 1, "listing_done": 1, "created_by": 1},
                )
                async for job in cursor:
                    pending = job.get("pending_trip_ids") or []
                    processed = set(job.get("processed_trip_ids") or [])
                    remaining = [t for t in pending if t not in processed]
                    # Resume if: listing not done yet OR there are unprocessed trips
                    if (not job.get("listing_done")) or remaining:
                        logger.info("auto-resuming interrupted job %s (remaining=%d)",
                                    job["job_id"], len(remaining))
                        await db.bulk_import_jobs.update_one(
                            {"job_id": job["job_id"]},
                            {"$set": {
                                "status": "running",
                                "finished_at": None,
                                "last_message": "Reanudación automática tras reinicio del servidor…",
                                "last_heartbeat": now_iso(),
                            }},
                        )
                        asyncio.create_task(_run_bulk_import_gestion(
                            job["job_id"], job.get("params") or {}, job.get("created_by") or ""
                        ))
            except Exception as e:
                logger.warning("auto_resume_interrupted_jobs watcher tick failed: %s", e)
            # Re-check every 60s. Cheap query, only matches `interrupted`.
            await asyncio.sleep(60)

    asyncio.create_task(_watcher())


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


@api.post("/catalog/import-from-trips-csv")
async def import_catalog_from_trips_csv(
    admin: Annotated[User, Depends(require_admin)],
    file_path: str = Query("/app/artifacts/catalog_db/app_operators.csv", description="Server-side CSV path"),
    wipe: bool = Query(False, description="Wipe experiences + hotels first"),
):
    """Build the catalog from a CSV of services used in past trips.

    Expected columns (semicolon-separated, latin-1 OR utf-8):
        ID_TRIP; Fecha_venta; Servicio; Ciudad; Proveedor; AD; CH; Sin_IVA; Con_IVA

    Each row → either an Experience (activity/transfer/train/etc.) or a Hotel
    (when Servicio matches hotel/apartament/resort keywords). Dedup by
    (name + provider + city), keeping the median price across occurrences.
    Providers are upserted automatically.
    """
    import csv as _csv
    import pathlib as _p

    fp = _p.Path(file_path)
    if not fp.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")

    # City → country lookup (covers the top cities seen in real data)
    city_country = {
        # Spain
        "Madrid": "España", "Barcelona": "España", "Sevilla": "España", "Seville": "España",
        "Valencia": "España", "Bilbao": "España", "Granada": "España", "Toledo": "España",
        "Cordoba": "España", "Córdoba": "España", "Ronda": "España", "Malaga": "España",
        "Málaga": "España", "San Sebastian": "España", "San Sebastián": "España",
        "Mallorca": "España", "Ibiza": "España", "Segovia": "España", "Salamanca": "España",
        "Logroño": "España", "La Rioja": "España", "Pamplona": "España", "Avila": "España",
        "Ávila": "España", "Cuenca": "España", "Marbella": "España", "Tenerife": "España",
        # Portugal
        "Lisbon": "Portugal", "Lisboa": "Portugal", "Porto": "Portugal", "Oporto": "Portugal",
        "Sintra": "Portugal", "Cascais": "Portugal", "Algarve": "Portugal", "Lagos": "Portugal",
        "Coimbra": "Portugal", "Evora": "Portugal", "Évora": "Portugal", "Douro": "Portugal",
        "Douro Valley": "Portugal", "Madeira": "Portugal", "Azores": "Portugal", "Braga": "Portugal",
        "Faro": "Portugal", "Aveiro": "Portugal",
        # Italy
        "Rome": "Italia", "Roma": "Italia", "Florence": "Italia", "Firenze": "Italia",
        "Florencia": "Italia", "Venice": "Italia", "Venezia": "Italia", "Venecia": "Italia",
        "Naples": "Italia", "Napoli": "Italia", "Milan": "Italia", "Milano": "Italia",
        "Sorrento": "Italia", "Positano": "Italia", "Amalfi": "Italia", "Capri": "Italia",
        "Pompeii": "Italia", "Tuscany": "Italia", "Toscana": "Italia", "Bologna": "Italia",
        "Verona": "Italia", "Siena": "Italia", "Pisa": "Italia", "Cinque Terre": "Italia",
        "Lake Como": "Italia", "Sicily": "Italia", "Sicilia": "Italia", "Palermo": "Italia",
        "Taormina": "Italia", "Catania": "Italia", "Matera": "Italia", "Puglia": "Italia",
        "Lecce": "Italia",
        # Morocco
        "Marrakech": "Marruecos", "Marrakesh": "Marruecos", "Casablanca": "Marruecos",
        "Fes": "Marruecos", "Fez": "Marruecos", "Rabat": "Marruecos", "Tangier": "Marruecos",
        "Chefchaouen": "Marruecos", "Essaouira": "Marruecos", "Merzouga": "Marruecos",
    }
    # Normalize duplicate city spellings → canonical
    city_aliases = {
        "Roma": "Rome", "Florencia": "Florence", "Firenze": "Florence",
        "Venecia": "Venice", "Venezia": "Venice", "Napoli": "Naples", "Milano": "Milan",
        "Lisboa": "Lisbon", "Oporto": "Porto", "Sevilla": "Seville", "Marrakesh": "Marrakech",
        "Fez": "Fes",
    }

    HOTEL_KW = ("hotel", "hostel", "hostal", "apartam", "apartment", "resort", "pousada",
                "riad", "villa", "b&b", "bed and breakfast", "lodge", "boutique stay")
    TRANSFER_KW = ("transfer", "taxi", "limo", "driver", "private car", "private vehicle")
    FLIGHT_KW = ("flight", "vuelo", "airline")
    TRAIN_KW = ("train", "tren", "renfe", "trenitalia", "italo", "ave ", "ave-")
    RESTAURANT_KW = ("restaur", "lunch", "dinner", "cena", " menu ", "wine pairing")

    def classify(name: str) -> str:
        n = name.lower()
        # Order matters: transfer/flight/train check first, otherwise "Transfer to Hotel X" gets miscategorized as hotel
        if any(k in n for k in TRANSFER_KW):
            return "transfer"
        if any(k in n for k in FLIGHT_KW):
            return "vuelo"
        if any(k in n for k in TRAIN_KW):
            return "transporte"
        if any(k in n for k in RESTAURANT_KW):
            return "restaurante"
        if any(k in n for k in HOTEL_KW):
            return "hotel"
        return "actividad"

    def tier_from_name(name: str) -> str:
        n = name.lower()
        if any(w in n for w in ("luxury", "deluxe", "5*", "5 star", "5-star")):
            return "luxury"
        if any(w in n for w in ("4*", "4 star", "boutique", "premium")):
            return "upscale"
        return "upscale"

    if wipe:
        await db.experiences.delete_many({})
        await db.hotels.delete_many({})

    # Try UTF-8 then fall back to Latin-1
    try:
        text = fp.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        text = fp.read_text(encoding="latin-1")

    rows = list(_csv.DictReader(text.splitlines(), delimiter=";"))

    # Group rows by (service_name, provider, city) → aggregate prices
    grouped: dict = {}
    for r in rows:
        svc = (r.get("Servicio") or "").strip()
        prov = (r.get("Proveedor") or "").strip()
        city_raw = (r.get("Ciudad") or "").strip()
        if not svc or not prov or not city_raw:
            continue
        city = city_aliases.get(city_raw, city_raw)
        key = (svc, prov, city)
        excl = r.get("Sin_IVA")
        incl = r.get("Con_IVA")
        def _num(v):
            if not v or v == "NULL":
                return None
            try:
                return float(v)
            except ValueError:
                return None
        e = _num(excl)
        i = _num(incl)
        grouped.setdefault(key, {"excl": [], "incl": []})
        if e is not None:
            grouped[key]["excl"].append(e)
        if i is not None:
            grouped[key]["incl"].append(i)

    def _median(lst):
        if not lst:
            return 0.0
        s = sorted(lst)
        n = len(s)
        return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2

    # Provider cache (upsert once)
    provider_cache: dict = {}
    exp_created = 0
    exp_skipped = 0
    hotel_created = 0
    hotel_skipped = 0

    for (svc, prov_name, city), agg in grouped.items():
        country = city_country.get(city)
        # Upsert provider
        if prov_name not in provider_cache:
            doc = await db.providers.find_one({"name": prov_name}, {"_id": 0})
            if not doc:
                doc = Provider(name=prov_name, country=country).model_dump()
                await db.providers.insert_one(dict(doc))
            provider_cache[prov_name] = doc
        provider = provider_cache[prov_name]
        price_excl = round(_median(agg["excl"]), 2)
        price_incl = round(_median(agg["incl"]) or price_excl, 2)

        kind = classify(svc)
        if kind == "hotel":
            existing = await db.hotels.find_one(
                {"name": svc, "city": city}, {"_id": 0}
            )
            if existing:
                hotel_skipped += 1
                continue
            h = Hotel(
                name=svc,
                city=city,
                country=country,
                tier=tier_from_name(svc),
                description=None,
                price_per_night_excl=price_excl,
                price_per_night_incl=price_incl,
                currency="EUR",
                contact=prov_name,
                notes=f"Importado del histórico de viajes. Proveedor: {prov_name}",
            )
            await db.hotels.insert_one(h.model_dump())
            hotel_created += 1
        else:
            existing = await db.experiences.find_one(
                {"title": svc, "provider_id": provider["provider_id"], "city": city},
                {"_id": 0},
            )
            if existing:
                exp_skipped += 1
                continue
            exp = Experience(
                title=svc,
                provider_id=provider["provider_id"],
                provider_name=prov_name,
                country=country,
                city=city,
                type=kind,
                price_tax_excl=price_excl,
                price_tax_incl=price_incl,
                price=price_incl,
                currency="EUR",
            )
            await db.experiences.insert_one(exp.model_dump())
            exp_created += 1

    return {
        "rows_scanned": len(rows),
        "unique_services": len(grouped),
        "experiences_created": exp_created,
        "experiences_skipped": exp_skipped,
        "hotels_created": hotel_created,
        "hotels_skipped": hotel_skipped,
        "providers_total": len(provider_cache),
        "wiped": wipe,
    }



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
    """Smart typeahead across the catalog.

    If type='alojamiento' → search HOTELS collection.
    Else → search EXPERIENCES collection with that type filter (if set).
    Tokenized AND-search on title/name + provider_name (+ hotel.city). Optional pre-filters: city, country.
    """
    import re as _re
    tokens = [t for t in (q or "").strip().split() if len(t) >= 2]

    if type == "alojamiento":
        # Search hotels
        flt: dict = {}
        if tokens:
            flt["$and"] = []
            for tok in tokens:
                safe = _re.escape(tok)
                flt["$and"].append({
                    "$or": [
                        {"name": {"$regex": safe, "$options": "i"}},
                        {"city": {"$regex": safe, "$options": "i"}},
                    ]
                })
        if city:
            flt["city"] = {"$regex": f"^{city}$", "$options": "i"}
        if country:
            flt["country"] = country
        proj = {"_id": 0, "hotel_id": 1, "name": 1, "city": 1, "country": 1, "tier": 1,
                "price_per_night_excl": 1, "price_per_night_incl": 1, "currency": 1}
        items = await db.hotels.find(flt, proj).sort("name", 1).limit(limit).to_list(limit)
        # Adapt to a service-compatible shape so the frontend can map it uniformly
        return [
            {
                "experience_id": None,
                "hotel_id": h["hotel_id"],
                "title": h["name"],
                "provider_name": None,
                "city": h.get("city"),
                "country": h.get("country"),
                "type": "alojamiento",
                "price_tax_excl": h.get("price_per_night_excl") or 0,
                "price_tax_incl": h.get("price_per_night_incl") or 0,
                "currency": h.get("currency") or "EUR",
                "tier": h.get("tier"),
            }
            for h in items
        ]

    # Default: search experiences
    flt: dict = {}
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


def _normalize_city(sheet_name: str) -> str:
    """Normalize city codes/sheet names to canonical city names."""
    s = (sheet_name or "").strip()
    table = {
        "MAD": "Madrid",
        "BCN": "Barcelona",
        "SEV": "Sevilla",
        "DV": "Douro Valley",
        "Oporto": "Porto",
        "Lisboa": "Lisbon",
        "Venecia": "Venice",
        "Florencia": "Florence",
        "Roma": "Rome",
        "Toscana": "Tuscany",
    }
    return table.get(s, s)


def _tier_from_category(cat: str) -> str:
    if not cat:
        return "standard"
    c = str(cat).strip().replace(" ", "").replace("*", "")
    if c == "5":
        return "luxury"
    if c == "4":
        return "upscale"
    if c == "3":
        return "comfort"
    if c == "2":
        return "standard"
    return "standard"


def _parse_hotels_sheet(ws, country: str, city: str):
    """Generic parser for the hotel sheets. Returns list of hotel dicts."""
    # Identify column indexes from header row
    headers: dict = {}
    for c in range(1, ws.max_column + 1):
        v = ws.cell(1, c).value
        if v:
            headers[str(v).strip().lower()] = c

    cat_col = headers.get("categoria")
    name_col = headers.get("nombre hotel") or headers.get("nombre")
    reserva_col = headers.get("reserva")
    notas_col = headers.get("notas")
    ciudad_col = headers.get("ciudad")  # used in Marruecos file (city is per-row)
    tipo_col = headers.get("tipo de alojamiento") or headers.get("apartamento")
    web_col = headers.get("web")
    car_col = headers.get("caracterísricas de alojamiento") or headers.get("caracteristicas de alojamiento") or headers.get("características de alojamiento")
    if not name_col:
        return []

    # Extra notes columns: anything beyond the known
    known = {cat_col, name_col, reserva_col, notas_col, ciudad_col, tipo_col, web_col, car_col}
    extra_cols = [c for c in range(1, ws.max_column + 1) if c not in known and c is not None]

    rows = []
    for r in range(2, ws.max_row + 1):
        name = ws.cell(r, name_col).value
        if not name:
            continue
        name = str(name).strip()
        if not name or name.lower().startswith("nombre"):
            continue

        cat = ws.cell(r, cat_col).value if cat_col else None
        tier = _tier_from_category(str(cat) if cat else "")

        # Concatenate notes from notas, reserva (skip "si"/"no"/"hotel"/"kimkim"), tipo, características, and any extra
        note_parts = []
        if reserva_col:
            v = ws.cell(r, reserva_col).value
            if v:
                v = str(v).strip()
                if v.lower() not in ("si", "no", "hotel", "kimkim", "yes"):
                    note_parts.append(f"reserva: {v}")
        if notas_col:
            v = ws.cell(r, notas_col).value
            if v and str(v).strip():
                note_parts.append(str(v).strip())
        if tipo_col:
            v = ws.cell(r, tipo_col).value
            if v and str(v).strip():
                note_parts.append(f"tipo: {str(v).strip()}")
        if car_col:
            v = ws.cell(r, car_col).value
            if v and str(v).strip():
                note_parts.append(str(v).strip())
        for c in extra_cols:
            v = ws.cell(r, c).value
            if v and str(v).strip():
                note_parts.append(str(v).strip())

        web = ""
        if web_col:
            wv = ws.cell(r, web_col).value
            if wv:
                web = str(wv).strip()

        # Per-row city if file is Marruecos style; else use sheet-derived city
        row_city = city
        if ciudad_col:
            cv = ws.cell(r, ciudad_col).value
            if cv:
                row_city = str(cv).strip()

        rows.append({
            "name": name,
            "city": row_city,
            "country": country,
            "tier": tier,
            "description": (note_parts[0] if note_parts else None),
            "notes": "\n".join(note_parts[1:]) if len(note_parts) > 1 else None,
            "contact": web or None,
            "price_per_night_excl": 0.0,
            "price_per_night_incl": 0.0,
            "currency": "EUR",
        })
    return rows


@api.post("/hotels/import-all-server")
async def import_all_hotels_server(
    admin: Annotated[User, Depends(require_admin)],
    base_path: str = Query("/app/artifacts/hoteles_db", description="Server dir containing hotel xlsx files"),
    wipe: bool = Query(False, description="Wipe hotels collection first"),
):
    """Walk the hotels directory and import every .xlsx file found.
    Country inferred from filename (ESPA/PORT/ITAL/MARRU).
    City inferred from sheet name (MAD→Madrid, etc.) or per-row Ciudad column.
    """
    import pathlib
    base = pathlib.Path(base_path)
    if not base.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {base_path}")

    if wipe:
        await db.hotels.delete_many({})

    files = list(base.rglob("*.xlsx"))
    total_created = 0
    total_skipped = 0
    file_results = []
    for fp in files:
        upn = fp.name.upper()
        country = None
        if "ESPA" in upn:
            country = "España"
        elif "PORT" in upn:
            country = "Portugal"
        elif "ITAL" in upn:
            country = "Italia"
        elif "MARRU" in upn:
            country = "Marruecos"
        elif "ALOJAMIENTO" in upn or "APART" in upn or "FAMILI" in upn:
            country = None  # multi-country file; city per sheet
        try:
            wb = openpyxl.load_workbook(fp, data_only=True)
            file_created = 0
            file_skipped = 0
            for sname in wb.sheetnames:
                ws = wb[sname]
                if ws.max_row < 2:
                    continue
                city = _normalize_city(sname)
                rows = _parse_hotels_sheet(ws, country=country, city=city)
                for row in rows:
                    # Dedup by (name, city)
                    existing = await db.hotels.find_one(
                        {"name": row["name"], "city": row["city"]}, {"_id": 0}
                    )
                    if existing:
                        file_skipped += 1
                        continue
                    h = Hotel(**row)
                    await db.hotels.insert_one(h.model_dump())
                    file_created += 1
            total_created += file_created
            total_skipped += file_skipped
            file_results.append({"file": fp.name, "country": country, "created": file_created, "skipped": file_skipped})
        except Exception as e:
            file_results.append({"file": fp.name, "error": str(e)})

    return {
        "files_scanned": len(files),
        "total_created": total_created,
        "total_skipped": total_skipped,
        "wiped": wipe,
        "files": file_results,
    }


# ===========================================================================
# AI Trainer: Training examples
# ===========================================================================
TripOutcome = Literal["sold", "not_sold", "pending"]


class TrainingExample(BaseModel):
    model_config = ConfigDict(extra="ignore")
    example_id: str = Field(default_factory=lambda: new_id("trn"))
    client_name: Optional[str] = None
    client_request: str
    # Client-facing itinerary (Travefy or similar)
    itinerary_url: Optional[str] = None
    itinerary_text: Optional[str] = None
    itinerary_structured: Optional[dict] = None
    # Internal operations view (gestion.viajadverdad.com) with providers, margins, real costs
    itinerary_url_ops: Optional[str] = None
    itinerary_text_ops: Optional[str] = None
    itinerary_structured_ops: Optional[dict] = None
    outcome: TripOutcome = "pending"
    notes: Optional[str] = None
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
    notes: Optional[str] = None


BulkJobStatus = Literal["queued", "running", "completed", "failed", "cancelled", "interrupted"]


class BulkImportJob(BaseModel):
    model_config = ConfigDict(extra="ignore")
    job_id: str = Field(default_factory=lambda: new_id("job"))
    status: BulkJobStatus = "queued"
    params: dict = Field(default_factory=dict)
    matched: int = 0          # total trip IDs found in listings (across statuses)
    scraped: int = 0          # successfully scraped & saved
    skipped: int = 0          # already existed in DB
    failed: int = 0           # scrape/parse errors
    errors: List[str] = Field(default_factory=list)
    last_message: str = ""
    started_at: str = Field(default_factory=now_iso)
    finished_at: Optional[str] = None
    created_by: Optional[str] = None
    # Persistence for resumability
    pending_trip_ids: List[str] = Field(default_factory=list)   # all IDs discovered
    processed_trip_ids: List[str] = Field(default_factory=list) # IDs already attempted
    trip_names: dict = Field(default_factory=dict)              # tid -> client name from listing
    listing_done: bool = False                                  # listing phase finished?
    last_heartbeat: str = Field(default_factory=now_iso)        # updated each loop tick


@api.get("/training-examples", response_model=List[TrainingExample])
async def list_training_examples(_: Annotated[User, Depends(current_user)]):
    items = await db.training_examples.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return items


@api.get("/training-examples/pending-request", response_model=List[TrainingExample])
async def list_pending_request_examples(_: Annotated[User, Depends(current_user)]):
    """Training examples imported from gestion that still need a client request."""
    items = await db.training_examples.find(
        {"$or": [{"client_request": ""}, {"client_request": None}]},
        {"_id": 0},
    ).sort("created_at", -1).to_list(1000)
    return items


@api.get("/training-examples/bulk-import-jobs", response_model=List[BulkImportJob])
async def list_bulk_import_jobs(_: Annotated[User, Depends(current_user)]):
    docs = await db.bulk_import_jobs.find({}, {"_id": 0}).sort("started_at", -1).to_list(30)
    return docs


@api.get("/training-examples/bulk-import-jobs/{job_id}", response_model=BulkImportJob)
async def get_bulk_import_job(job_id: str, _: Annotated[User, Depends(current_user)]):
    doc = await db.bulk_import_jobs.find_one({"job_id": job_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    return doc


@api.post("/training-examples/bulk-import-jobs/{job_id}/cancel", response_model=BulkImportJob)
async def cancel_bulk_import_job(job_id: str, _: Annotated[User, Depends(current_user)]):
    """Mark a running job as cancelled. The background worker polls this status
    between actions and stops cleanly, scraping whatever it has already listed."""
    doc = await db.bulk_import_jobs.find_one({"job_id": job_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    if doc["status"] in ("completed", "failed", "cancelled", "interrupted"):
        return doc
    await _update_job(
        job_id,
        status="cancelled",
        last_message="Cancelado por el usuario. Procesando viajes ya listados…",
    )
    fresh = await db.bulk_import_jobs.find_one({"job_id": job_id}, {"_id": 0})
    return fresh


@api.post("/training-examples/bulk-import-jobs/{job_id}/resume", response_model=BulkImportJob)
async def resume_bulk_import_job(job_id: str, user: User = Depends(current_user)):
    """Pick up an interrupted/failed/cancelled job exactly where it stopped.
    Listing IDs already discovered are kept; only un-processed trip_ids will be
    re-scraped. URL-level dedup also prevents duplicates if any race occurs."""
    doc = await db.bulk_import_jobs.find_one({"job_id": job_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    if doc["status"] == "running":
        return doc
    if doc["status"] == "completed":
        # Nothing to do — explicitly tell the caller.
        return doc
    await _update_job(
        job_id,
        status="running",
        finished_at=None,
        last_message="Reanudando…",
        last_heartbeat=now_iso(),
    )
    asyncio.create_task(_run_bulk_import_gestion(job_id, doc.get("params") or {}, user.email))
    fresh = await db.bulk_import_jobs.find_one({"job_id": job_id}, {"_id": 0})
    return fresh


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
    await bump_version(db)
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
        await bump_version(db)
    doc = await db.training_examples.find_one({"example_id": example_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    return doc


@api.delete("/training-examples/{example_id}")
async def delete_training_example(example_id: str, _: Annotated[User, Depends(current_user)]):
    res = await db.training_examples.delete_one({"example_id": example_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    await bump_version(db)
    return {"ok": True}


@api.get("/ai/retrieval/stats")
async def retrieval_stats(_: Annotated[User, Depends(current_user)]):
    """Inspect the TF-IDF index status (size + vocabulary)."""
    r = await get_retriever(db)
    return {
        "docs": len(r.docs),
        "features": int(r.matrix.shape[1]) if r.matrix.shape[0] > 0 else 0,
        "version": r.version,
        "outcome_breakdown": {
            "sold": sum(1 for d in r.docs if d.get("outcome") == "sold"),
            "not_sold": sum(1 for d in r.docs if d.get("outcome") == "not_sold"),
            "pending": sum(1 for d in r.docs if d.get("outcome") == "pending"),
        },
    }


@api.post("/ai/retrieval/search")
async def retrieval_search(
    payload: dict = Body(...),
    _: Annotated[User, Depends(current_user)] = None,
):
    """Manual semantic search over training examples — useful to preview what the
    AI generator will see for a given client request."""
    query = (payload.get("query") or "").strip()
    k = int(payload.get("k") or 10)
    if not query:
        raise HTTPException(status_code=400, detail="query es obligatorio")
    r = await get_retriever(db)
    hits = r.top_k(query, k=k, min_score=0.01)
    return {
        "matches": [{
            "example_id": h.get("example_id"),
            "client_name": h.get("client_name"),
            "outcome": h.get("outcome"),
            "score": h.get("_score"),
            "client_request": (h.get("client_request") or "")[:300],
        } for h in hits],
        "total_indexed": len(r.docs),
    }


@api.post("/training-examples/bulk-import-gestion", response_model=BulkImportJob)
async def bulk_import_gestion(
    payload: dict = Body(...),
    user: User = Depends(current_user),
):
    """Kick off a background job that logs in to gestion.viajadverdad.com, lists
    /trips matching the given filters and scrapes each one into a TrainingExample.

    payload accepts:
        agent      str | ""   filter "Agente de Ventas" (empty = all)
        source     str        filter "Source" (e.g. "KimKim")
        status     "open" | "closed" | "both" | "all"
        date_from  "DD/MM/YYYY" filter Fecha de Venta lower bound
        date_to    "DD/MM/YYYY" filter Fecha de Venta upper bound
        outcome    "sold" | "not_sold" | "pending"  (tag every imported example)
        limit      int        safety cap on number of trips (default 500)

    Returns the queued BulkImportJob immediately; poll
    GET /training-examples/bulk-import-jobs/{job_id} for progress.
    """
    job = BulkImportJob(params=payload, created_by=user.email, status="queued",
                        last_message="En cola…")
    await db.bulk_import_jobs.insert_one(job.model_dump())
    asyncio.create_task(_run_bulk_import_gestion(job.job_id, payload, user.email))
    return job


async def _update_job(job_id: str, **fields):
    """Patch a BulkImportJob document."""
    if not fields:
        return
    await db.bulk_import_jobs.update_one({"job_id": job_id}, {"$set": fields})


async def _is_cancelled(job_id: str) -> bool:
    doc = await db.bulk_import_jobs.find_one({"job_id": job_id}, {"status": 1})
    return bool(doc and doc.get("status") == "cancelled")


def _extract_client_name(text: str) -> str:
    if not text:
        return ""
    if "Lead Name" in text:
        chunks = text.split("Lead Name", 1)[1].split("\n")
        for ln in chunks[1:6]:
            ln = ln.strip()
            if ln and ln.lower() not in ("teléfono", "telefono", "phone", "email", "agente", "agent"):
                return ln[:80]
    return ""


def _clean_trip_name(raw: str) -> str:
    """Strip Fabrik link decorations and the ubiquitous "_facturado…" suffix."""
    import re as _re
    s = (raw or "").replace("\t", " ")
    # Collapse whitespace
    s = " ".join(s.split())
    # Drop UI prefixes added by Fabrik in the row link text
    for prefix in ("Edit", "View", "Add"):
        if s.startswith(prefix):
            s = s[len(prefix):].strip()
    # Cut at "_facturado" / "_INCIDENCIA" / opening parenthesis with notes
    s = _re.split(r"_facturado|_INCIDENCIA|_pendiente|_no facturado", s, maxsplit=1, flags=_re.IGNORECASE)[0]
    s = s.strip(" _-")
    return s[:80]


async def _run_bulk_import_gestion(job_id: str, params: dict, user_email: str):
    """Background coroutine that drives the full bulk-import workflow.

    1. Login once into gestion.viajadverdad.com
    2. For each requested status (open / closed), apply filters on /trips,
       paginate and harvest every trip ID.
    3. For each unique trip ID, scrape the ops view + LLM-parse it and
       create a TrainingExample (client_request stays empty so the user
       can fill it later from the AI Trainer UI).
    """
    from playwright.async_api import async_playwright
    from scraper import _render_url, _parse_with_llm, GESTION_USER, GESTION_PASS

    agent = (params.get("agent") or "").strip()
    source = (params.get("source") or "").strip()
    raw_status = (params.get("status") or "all_sold").strip().lower()
    if raw_status in ("all_sold", "todos_vendidos"):
        statuses = ["open", "closed", "terminado"]
    elif raw_status in ("all", "both", "ambos", "todos", ""):
        statuses = ["open", "closed"]
    elif raw_status in ("open", "abierto"):
        statuses = ["open"]
    elif raw_status in ("closed", "cerrado"):
        statuses = ["closed"]
    elif raw_status in ("terminado", "finished"):
        statuses = ["terminado"]
    else:
        statuses = [raw_status]
    date_from = (params.get("date_from") or "").strip()
    date_to = (params.get("date_to") or "").strip()
    raw_outcome = (params.get("outcome") or "sold").strip().lower()
    outcome: TripOutcome = raw_outcome if raw_outcome in ("sold", "not_sold", "pending") else "sold"
    try:
        limit = max(1, min(int(params.get("limit") or 500), 2000))
    except Exception:
        limit = 500

    await _update_job(job_id, status="running",
                      last_message="Iniciando navegador y login en gestion…",
                      last_heartbeat=now_iso())

    # Recover any previously listed trip_ids if the same job is resumed
    job_doc = await db.bulk_import_jobs.find_one({"job_id": job_id}, {"_id": 0}) or {}
    all_trip_ids: list[str] = list(job_doc.get("pending_trip_ids") or [])
    trip_names: dict[str, str] = dict(job_doc.get("trip_names") or {})
    processed_set: set[str] = set(job_doc.get("processed_trip_ids") or [])
    seen: set[str] = set(all_trip_ids)
    listing_done: bool = bool(job_doc.get("listing_done"))

    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
            try:
                ctx = await browser.new_context(user_agent="Mozilla/5.0")
                page = await ctx.new_page()
                page.set_default_timeout(20000)
                page.set_default_navigation_timeout(25000)

                # ---------- LOGIN ----------
                try:
                    await page.goto("https://gestion.viajadverdad.com/login",
                                    wait_until="domcontentloaded", timeout=25000)
                    await page.fill('input[name="username"]', GESTION_USER)
                    await page.fill('input[name="password"]', GESTION_PASS)
                    await page.click('button[type="submit"], input[type="submit"]')
                    await page.wait_for_load_state("domcontentloaded", timeout=20000)
                    await page.wait_for_timeout(1500)
                    if "/login" in page.url:
                        await _update_job(job_id, status="failed",
                                          last_message="Login en gestion falló (revisa GESTION_VIAJADVERDAD_USER/PASS)",
                                          finished_at=now_iso())
                        return
                except Exception as e:
                    await _update_job(job_id, status="failed",
                                      last_message=f"Error de login: {e}",
                                      finished_at=now_iso())
                    return

                # ---------- COLLECT TRIP IDS PER STATUS ----------
                async def fabrik_apply_filters(status_value: str) -> None:
                    """Apply Fabrik /trips filters using the verified element IDs.

                    Selectors discovered on gestion.viajadverdad.com/trips:
                      - select#app_trips___agentvalue    (label = "All"/"Beatriz"/…)
                      - select#app_trips___sourcevalue   (value = "KimKim"/…)
                      - select#app_trips___statusvalue   (value = "abierto"/"cerrado"/…)
                      - input#app_trips___booking_date_1_com_fabrik_1_filter_range_0_\\.0  (Fecha de Venta desde)
                      - input#app_trips___booking_date_1_com_fabrik_1_filter_range_1_\\.0  (Fecha de Venta hasta)
                    """
                    # Agent — select by visible label (e.g. "Beatriz")
                    if agent:
                        try:
                            await page.select_option('#app_trips___agentvalue', label=agent, timeout=5000)
                        except Exception:
                            try:
                                await page.select_option('#app_trips___agentvalue', value=agent, timeout=5000)
                            except Exception:
                                pass
                    # Source — select by value (matches the visible label too in this Fabrik config)
                    if source:
                        try:
                            await page.select_option('#app_trips___sourcevalue', value=source, timeout=5000)
                        except Exception:
                            try:
                                await page.select_option('#app_trips___sourcevalue', label=source, timeout=5000)
                            except Exception:
                                pass
                    # Status — lowercase value
                    if status_value:
                        try:
                            await page.select_option('#app_trips___statusvalue', value=status_value, timeout=5000)
                        except Exception:
                            pass
                    # Booking date range. Dot inside the ID requires attribute selector.
                    if date_from:
                        try:
                            await page.fill(
                                'input[id="app_trips___booking_date_1_com_fabrik_1_filter_range_0_.0"]',
                                date_from, timeout=5000,
                            )
                        except Exception:
                            pass
                    if date_to:
                        try:
                            await page.fill(
                                'input[id="app_trips___booking_date_1_com_fabrik_1_filter_range_1_.0"]',
                                date_to, timeout=5000,
                            )
                        except Exception:
                            pass
                    # Submit (Fabrik filter "Go" button is `name="filter"`)
                    try:
                        btn = await page.query_selector('button[name="filter"], input[name="filter"]')
                        if btn:
                            await btn.click(timeout=5000)
                        else:
                            await page.evaluate(
                                "document.querySelector('form[name=\"listform_1_com_fabrik_1\"], form.fabrikForm, .fabrik_filter')?.form?.submit()"
                            )
                    except Exception:
                        pass
                    # Wait for the post-submit reload using DOM-content (much more reliable
                    # than networkidle on Fabrik pages, which keep firing AJAX in background).
                    try:
                        await page.wait_for_load_state("domcontentloaded", timeout=15000)
                    except Exception:
                        pass
                    await page.wait_for_timeout(2000)

                async def _process_status(st: str) -> None:
                    """Drive a single status through filter→limit→pagination→collect."""
                    status_label = {"open": "abierto", "closed": "cerrado", "terminado": "terminado"}.get(st, st)
                    await _update_job(
                        job_id, matched=len(all_trip_ids),
                        last_message=f"Aplicando filtros (estado={status_label})…",
                    )
                    await page.goto("https://gestion.viajadverdad.com/trips",
                                    wait_until="domcontentloaded", timeout=20000)
                    await page.wait_for_timeout(1500)
                    await fabrik_apply_filters(status_label)

                    # Maximise page size so we minimise pagination hops (Fabrik default = 100).
                    try:
                        opts = await page.evaluate("""() => {
                            const s = document.querySelector('#limit1');
                            if (!s) return [];
                            return Array.from(s.options).map(o => parseInt(o.value, 10)).filter(n => !isNaN(n));
                        }""")
                        if opts:
                            target = str(max(opts))     # typically "500"
                            current = await page.eval_on_selector('#limit1', 'e => e.value')
                            if current != target:
                                try:
                                    async with page.expect_navigation(wait_until="domcontentloaded", timeout=15000):
                                        await page.select_option('#limit1', value=target, timeout=5000)
                                except Exception:
                                    pass
                                await page.wait_for_timeout(1500)
                    except Exception as e:
                        logger.info("page-size selector skipped: %s", e)

                    # Paginate and harvest IDs
                    page_count = 0
                    while page_count < 50:  # hard cap to avoid infinite loops
                        if await _is_cancelled(job_id):
                            return
                        page_count += 1
                        rows = await page.evaluate("""() => {
                            const map = new Map();
                            document.querySelectorAll('a[href*="/trips/form/"], a[href*="/trips/details/"]').forEach(a => {
                                const m = a.href.match(/\\/trips\\/(?:form|details)\\/\\d+\\/(\\d+)/);
                                if (!m) return;
                                const id = m[1];
                                const text = (a.innerText || '').trim();
                                if (!map.has(id) || (text && text.length > (map.get(id) || '').length)) {
                                    map.set(id, text);
                                }
                            });
                            return [...map.entries()].map(([id, text]) => ({id, text}));
                        }""")
                        new_added = 0
                        for row in rows:
                            tid = row["id"]
                            if tid not in seen:
                                seen.add(tid)
                                all_trip_ids.append(tid)
                                cleaned = _clean_trip_name(row.get("text") or "")
                                if cleaned:
                                    trip_names[tid] = cleaned
                                new_added += 1
                                if len(all_trip_ids) >= limit:
                                    break
                        # Persist progress so a crash mid-listing doesn't lose IDs.
                        await _update_job(
                            job_id, matched=len(all_trip_ids),
                            pending_trip_ids=all_trip_ids[:],
                            trip_names=trip_names,
                            last_message=f"Listando viajes (estado={status_label}) · página {page_count} · +{new_added}",
                        )
                        if len(all_trip_ids) >= limit:
                            return
                        if new_added == 0 and page_count > 1:
                            return
                        # Try to advance pagination
                        try:
                            nxt = await page.query_selector(
                                'a[title="Next"], a[title="Siguiente"], '
                                'li.pagination-next a:not(.disabled), '
                                '.pagination li.next a, a:has-text("›"), a:has-text("→")'
                            )
                            if not nxt:
                                return
                            href = await nxt.get_attribute("href")
                            cls = (await nxt.get_attribute("class") or "").lower()
                            if "disabled" in cls or href in (None, "", "#"):
                                return
                            await nxt.click(timeout=5000)
                            await page.wait_for_load_state("domcontentloaded", timeout=15000)
                            await page.wait_for_timeout(1500)
                        except Exception:
                            return

                for st_idx, st in enumerate(statuses):
                    if listing_done:
                        # Listing previously completed — skip to scraping phase.
                        await _update_job(
                            job_id, matched=len(all_trip_ids),
                            last_message=f"Reanudando · saltando listado (ya hecho, {len(all_trip_ids)} viajes)",
                            last_heartbeat=now_iso(),
                        )
                        break
                    if len(all_trip_ids) >= limit:
                        break
                    if await _is_cancelled(job_id):
                        break
                    try:
                        # Hard 180s cap per status so a hung filter never blocks the next status.
                        await asyncio.wait_for(_process_status(st), timeout=180)
                    except asyncio.TimeoutError:
                        await _update_job(
                            job_id, matched=len(all_trip_ids),
                            last_message=f"Timeout listando estado={st} tras 180s · sigo con el siguiente",
                        )
                    except Exception as e:
                        await _update_job(
                            job_id, matched=len(all_trip_ids),
                            last_message=f"Error listando estado={st}: {str(e)[:140]} · sigo con el siguiente",
                        )
                        logger.warning("listing error for status %s: %s", st, e)

                await page.close()
            finally:
                await browser.close()
    except Exception as e:
        await _update_job(job_id, status="failed",
                          last_message=f"Fallo en la fase de listado: {e}",
                          finished_at=now_iso())
        logger.exception("bulk-import listing phase failed")
        return

    # Listing phase done — record this so a resume jumps straight to scraping.
    if not listing_done:
        await _update_job(
            job_id, listing_done=True,
            pending_trip_ids=all_trip_ids[:],
            trip_names=trip_names,
            matched=len(all_trip_ids),
            last_heartbeat=now_iso(),
        )

    trip_ids = all_trip_ids[:limit]

    if not trip_ids:
        await _update_job(
            job_id, status="completed", finished_at=now_iso(),
            last_message="No se encontró ningún viaje con esos filtros.",
        )
        return

    # ---------- SCRAPE EACH TRIP ----------
    # Start counters from whatever the resumed job already has, so progress is cumulative.
    job_doc2 = await db.bulk_import_jobs.find_one({"job_id": job_id}, {"_id": 0}) or {}
    created = int(job_doc2.get("scraped") or 0)
    skipped = int(job_doc2.get("skipped") or 0)
    failed = int(job_doc2.get("failed") or 0)
    errors: list[str] = list(job_doc2.get("errors") or [])
    notes_tag = (
        f"Auto-import gestion (agente={agent or 'Todos'} · source={source or '—'} · "
        f"estado={','.join(statuses)} · fechas={date_from or '—'}→{date_to or '—'} · outcome={outcome})"
    )

    # Pick trips that haven't been processed yet (resumability).
    remaining = [tid for tid in trip_ids if tid not in processed_set]
    await _update_job(
        job_id, matched=len(trip_ids),
        last_message=(
            f"{len(trip_ids)} viajes en cola · {len(processed_set)} ya procesados · "
            f"{len(remaining)} pendientes. Iniciando scraping…"
        ),
        last_heartbeat=now_iso(),
    )

    if not remaining:
        await _update_job(
            job_id, status="completed", finished_at=now_iso(),
            last_message=(
                f"Completado · {created} creados (sesiones anteriores) · "
                f"nada que hacer ahora."
            ),
        )
        return

    # ---------- SCRAPE EACH TRIP ----------
    for i, tid in enumerate(remaining):
        if await _is_cancelled(job_id):
            break
        url = f"https://gestion.viajadverdad.com/trips/form/1/{tid}"
        existing = await db.training_examples.find_one(
            {"itinerary_url_ops": url}, {"_id": 0}
        )
        if existing:
            skipped += 1
            processed_set.add(tid)
            await _update_job(
                job_id, skipped=skipped,
                processed_trip_ids=list(processed_set),
                last_heartbeat=now_iso(),
                last_message=f"[{i + 1}/{len(remaining)}] saltado (ya importado) · trip {tid}",
            )
            continue
        try:
            rendered = await _render_url(url)
            text = rendered.get("text", "")
            structured = (
                await _parse_with_llm(text)
                if rendered.get("ok") else
                {"days": [], "notes": rendered.get("error") or "scrape_failed"}
            )
            client_name = trip_names.get(tid) or _extract_client_name(text)
            ex = TrainingExample(
                client_name=client_name,
                client_request="",  # pending — user fills later
                itinerary_url=None,
                itinerary_url_ops=url,
                itinerary_text_ops=text,
                itinerary_structured_ops=structured,
                outcome=outcome,    # selectable per-import (sold / not_sold / pending)
                notes=notes_tag,
                created_by=user_email,
            )
            await db.training_examples.insert_one(ex.model_dump())
            created += 1
            processed_set.add(tid)
            label = client_name or structured.get("trip_name") or tid
            await _update_job(
                job_id, scraped=created,
                processed_trip_ids=list(processed_set),
                last_heartbeat=now_iso(),
                last_message=f"[{i + 1}/{len(remaining)}] OK · {label}",
            )
        except Exception as e:
            failed += 1
            short = str(e)[:160]
            errors.append(f"trip {tid}: {short}")
            processed_set.add(tid)   # don't retry hard failures next resume
            await _update_job(
                job_id, failed=failed,
                processed_trip_ids=list(processed_set),
                errors=errors[-50:],
                last_heartbeat=now_iso(),
                last_message=f"[{i + 1}/{len(remaining)}] ERROR trip {tid}: {short}",
            )
            logger.warning("bulk import trip %s failed: %s", tid, e)

    was_cancelled = await _is_cancelled(job_id)
    await _update_job(
        job_id,
        status="cancelled" if was_cancelled else "completed",
        scraped=created,
        skipped=skipped,
        failed=failed,
        errors=errors[-50:],   # keep only last 50 to avoid bloat
        finished_at=now_iso(),
        last_message=(
            ("Cancelado por el usuario · " if was_cancelled else "Completado · ")
            + f"{created} creados · {skipped} saltados · {failed} con error"
        ),
    )
    # Bulk imports may have inserted dozens of examples — invalidate the
    # retrieval index so the next /ai/generate sees them.
    if created > 0:
        await bump_version(db)



async def scrape_itinerary_url(
    payload: dict = Body(...),
    _: User = Depends(current_user),
):
    """Render a URL with a real headless browser and parse it into structured JSON.

    Returns {"ok", "source", "text", "structured": {days, hotels, ...}, "error"}.
    """
    url = (payload.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL es obligatoria")
    from scraper import scrape_and_parse
    try:
        result = await scrape_and_parse(url)
    except Exception as e:
        logger.exception("scrape failed")
        raise HTTPException(status_code=500, detail=f"Scrape error: {e}")
    return result


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
- Output ONLY the JSON object. No prose before or after.

BUSINESS FACT SHEET — these are REAL averages computed over 59 trips this agency actually sold:

1) BUDGET FLEXIBILITY (CRITICAL):
   - 47% of clients accepted to pay ABOVE the upper bound of the budget range they declared.
   - Only 16% paid below the declared minimum.
   - Median ratio of "PVP actually paid / declared mid-budget" = 1.10x.
   - In extreme cases (e.g. Mary French) clients paid 1.80x their declared range.
   → DO NOT design to the middle of the declared range. AIM AT THE UPPER BOUND, and feel free to gently exceed it by 5-15% if the resulting itinerary is clearly better. The declared budget is a directional hint, NOT a hard cap.

2) STATED "TIER" IS A WEAK SIGNAL:
   - "Basic" clients have paid anywhere from $1,349 to $10,810 per person.
   - "Budget" clients have paid MORE than "Mid-range" clients in median.
   - Only "Luxury" is a reliable upmarket signal.
   → If the request says tier=Basic/Mid-range/Budget, do NOT shrink to the cheapest possibilities. Look at the budget range, the destinations, the activity preferences and the group composition for the real positioning.

3) MARGIN TARGETS (the agency keeps ~70% of what the client pays; KimKim takes ~30%):
   - Median margin over ingresado: 28%.
   - Top-margin sold trips reached 40-43% (Allison Ness, Dale Pfost, Melody McCaulla).
   - Worst-margin sold trips fell to 10-12% (Deb Thompson, Donald Hrabal) and should not be replicated.
   → Prefer service combinations that achieve a healthy markup spread. When two experiences are interchangeable, prefer the higher-margin one (typically the one with a clearer markup over coste).

4) TRIP DURATION HONORED:
   - 91% of sold itineraries deliver EXACTLY the number of days the client requested.
   → Match the requested duration to the day unless an obvious operational reason forces a shift.

5) DAILY DENSITY:
   - Median sold trip = 1.2 activities/day.
   - Avoid over-packing days (more than 3 activities) — it correlates with NOT_SOLD.

6) DESTINATION FOOTPRINT:
   - Italy 61% · Portugal 25% · Spain 14% of the historical sold volume.
   - When the destination is Italy/Portugal/Spain you have many sold matches; use them.
   - For other destinations, lean harder on the explicit preferences in the request.

In the "summary" field, briefly explain WHY this draft fits the request, mentioning which 1-2 sold patterns inspired it.

CRITICAL READING RULES — learned from past mistakes:

A) DETECT "CAMINO" CONTEXT IN THE REQUEST.
   Phrases like "Camino", "Camino de Santiago", "Portuguese Camino", "Camino Francés"
   may mean two very different things — read the full request twice before deciding:
   - If the dates of the Camino are STATED SEPARATELY (e.g. "walking the Camino on June 21 for a week"),
     the new trip you build does NOT include the Camino. Build a normal Portugal/Spain itinerary.
   - If the request says "walking the Camino to Santiago [during/within] this trip", reserve
     5-9 days for the Camino itself plus an arrival hub (Saint-Jean / Tui / Sarria) and Santiago
     as the final stop. Surround it with 2-4 days of regular tourism before/after.
   - If the request says "AFTER walking the Camino we'd like…", the Camino is BEFORE these dates —
     ignore it for the itinerary.

B) CLIENT WISHLIST OF SIGHTS  ≠  ONE ACTIVITY PER SIGHT.
   When a client lists many monuments/museums (e.g. "Pena Palace, Quinta da Regaleira, Évora
   Cathedral, Batalha, Jerónimos, Belém Tower, Discoveries Monument…"), DO NOT create one
   service per sight. Use COMBINED tours from the library that cover them:
   - Sintra → "Sintra & Cascais (small group)" covers Pena + Quinta da Regaleira + Cabo da Roca
   - Lisbon Belém area → "Belém Tuk-Tuk Tour" covers Jerónimos + Belém Tower + Discoveries
   - The remaining sights become free-day self-guided visits, not paid activities.

C) DO NOT SLEEP IN SINTRA OR IN SMALL TOURIST TOWNS WHEN LISBON IS NEARBY.
   Sold pattern: Sintra is a day trip from Lisbon. Same for Cascais, Óbidos, Setúbal, Évora,
   Toledo, Segovia. Sleep in the main hub and do the excursion. Only sleep in a small town if
   the client explicitly asks for it or the route distance forces it.

D) REUSE THE SAME HOTEL ON ROUND-TRIPS.
   If the trip returns to Lisbon/Madrid/Rome at the end, reuse the same hotel as the opening
   stay (not a new one). This is the dominant pattern across SOLD trips and clients value the
   continuity. Pick the better hotel for the longer stay.

E) PORTUGAL PRICING REALITY CHECK.
   Across 14 sold Portugal trips, the median PVP/pax is **$3,820** (range $1,349 - $12,740).
   - "Basic" tier Portugal: median ~$3,500-4,500/pax for 10-14 days
   - "Mid-range" tier Portugal: median ~$4,500-5,500/pax for 10-14 days
   - "Comfort" / "Upscale" boutique Portugal: $5,500-7,500/pax for 10-14 days
   When the resulting markup pushes you above 1.3x the client's declared mid-budget, REVIEW
   the choices: too many overnights, too many private guided tours, too high a hotel tier.

F) KIMKIM COMMISSION VARIES — assume default 15% (range 8-30%).
   This affects the gap between Precio Final (what the client pays) and Ingresado (what the
   agency receives). Target agency margin: 25-28% on Ingresado.

G) "5 OVERNIGHT LOCATIONS" / "FAST PACE" IS ASPIRATIONAL, NOT LITERAL.
   When the client requests many overnight stops BUT also lists many water/active activities
   in ONE region (catamaran, kayak, snorkel, surf, horseback, scuba, SUP), DOWNGRADE to 2-3
   overnight bases — typically Lisbon hub + Algarve/Lagos hub. Sold pattern: a 14-day Portugal
   trip with 5+ water activities collapses to Lisbon (4-5n) + Lagos (6-7n) + Lisbon return (1-2n).
   Concentration in one coastal hub for 6-7 nights is what actually sells.

H) HOTEL TIER VOCABULARY IS NOISE — TRUST THE BUDGET, NOT THE WORDS.
   Clients write contradictory phrases like "Basic, around $5,600-$7,000, Upscale, midrange-boutique".
   In our SOLD inventory the actual mapping is:
   - Budget given $1,500-3,000/pax → hotel €60-90/night
   - Budget $3,000-5,000/pax       → hotel €90-140/night (the dominant midrange-boutique)
   - Budget $5,000-8,000/pax       → hotel €130-200/night
   - Budget $8,000+/pax            → hotel €250+/night
   ALWAYS check budget per person per night before picking a 5* hotel. Calculate quickly:
   PVP_per_pax / nights ≈ daily spend, and HOTEL should be ~40-50% of daily spend in Portugal/Spain.

I) "OFF THE BEATEN PATH" + ACTIVE CLIENT  →  ADD UNREQUESTED LOCAL EXPERIENCES.
   In sold trips, when the client lists 3+ active outdoor activities, the agency adds 1-2
   complementary EXPERIENCES the client did NOT ask for but that fit the region — e.g. wine
   tasting at a quinta, countryside quad, foodie tour. These are high-margin upsells that
   correlate with sold outcomes. Add 1 such bonus per 5 days of trip."""


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


# Country detection — exact tokens used in the DB (Spanish names).
_COUNTRY_KEYWORDS = {
    "Portugal":  ["portugal", "lisbon", "lisboa", "porto", "sintra", "évora", "evora",
                  "douro", "batalha", "alentejo", "algarve", "obidos", "óbidos",
                  "coimbra", "cascais", "nazaré", "nazare", "madeira", "azores"],
    "España":    ["spain", "españa", "madrid", "barcelona", "sevilla", "seville",
                  "granada", "valencia", "bilbao", "san sebastian", "san sebastián",
                  "toledo", "córdoba", "cordoba", "málaga", "malaga", "mallorca",
                  "ibiza", "tenerife", "asturias", "rioja", "ronda"],
    "Italia":    ["italy", "italia", "rome", "roma", "florence", "firenze", "venice",
                  "venezia", "milan", "milano", "naples", "napoli", "tuscany",
                  "toscana", "sicily", "sicilia", "amalfi", "matera", "puglia",
                  "apulia", "como", "verona", "bologna", "cinque terre", "capri"],
    "Marruecos": ["morocco", "marruecos", "marrakech", "marrakesh", "fez", "fes",
                  "casablanca", "essaouira", "chefchaouen", "rabat", "merzouga",
                  "atlas", "sahara"],
}


def _detect_country(text: str) -> Optional[str]:
    """Pick the country whose keywords appear most often in the request text."""
    if not text:
        return None
    t = text.lower()
    scores: dict[str, int] = {}
    for country, kws in _COUNTRY_KEYWORDS.items():
        scores[country] = sum(1 for kw in kws if kw in t)
    best = max(scores.items(), key=lambda x: x[1])
    return best[0] if best[1] > 0 else None


def _detect_cities(text: str, country: Optional[str]) -> list[str]:
    """Detect specific cities mentioned for the (optionally) detected country.
    Returns city names as they appear in the DB."""
    if not text:
        return []
    t = text.lower()
    cities_for = {
        "Portugal": {
            "lisbon": "Lisbon", "lisboa": "Lisbon",
            "porto": "Porto", "oporto": "Porto",
            "sintra": "Sintra", "évora": "Évora", "evora": "Évora",
            "douro": "Douro", "batalha": "Batalha", "óbidos": "Óbidos", "obidos": "Óbidos",
            "coimbra": "Coimbra", "cascais": "Cascais", "nazaré": "Nazaré", "nazare": "Nazaré",
            "alentejo": "Alentejo", "algarve": "Algarve", "madeira": "Madeira",
        },
        "España": {
            "madrid": "Madrid", "barcelona": "Barcelona", "sevilla": "Sevilla",
            "seville": "Seville", "granada": "Granada", "valencia": "Valencia",
            "bilbao": "Bilbao", "san sebastian": "San Sebastian",
            "toledo": "Toledo", "córdoba": "Córdoba", "cordoba": "Córdoba",
            "málaga": "MALAGA", "malaga": "MALAGA", "ronda": "Ronda",
        },
        "Italia": {
            "rome": "Rome", "roma": "Rome", "florence": "Florence", "firenze": "Florence",
            "venice": "Venice", "venezia": "Venice", "milan": "Milan", "milano": "Milan",
            "naples": "Naples", "napoli": "Naples",
            "tuscany": "Tuscany", "toscana": "Tuscany",
            "sicily": "Sicilia", "sicilia": "Sicilia",
            "amalfi": "Amalfi Coast", "matera": "Apulia + Matera",
            "puglia": "Apulia + Matera", "apulia": "Apulia + Matera",
        },
        "Marruecos": {
            "marrakech": "Marrakech", "marrakesh": "Marrakech",
            "fez": "Fez", "fes": "Fez", "casablanca": "Casablanca",
            "essaouira": "Essaouira", "chefchaouen": "Chefchaouen",
        },
    }
    pool = dict(cities_for.get(country, {})) if country else {}
    if not pool:
        for cs in cities_for.values():
            pool.update(cs)
    found: list[str] = []
    seen: set[str] = set()
    for kw, name in pool.items():
        if kw in t and name not in seen:
            found.append(name)
            seen.add(name)
    return found


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
    # ----------------------------------------------------------------------
    # CASCADE FILTERING — pick context that is RELEVANT to the destination.
    #   1. Detect country and specific cities from the new request.
    #   2. Catalog (experiences + hotels) is filtered to that country
    #      AND boosted for the mentioned cities.
    #   3. Training examples are filtered to the same country before doing
    #      the TF-IDF retrieval, so "Portugal" requests don't surface Italy
    #      itineraries unless we explicitly have to fall back.
    # ----------------------------------------------------------------------
    country = _detect_country(request_text)
    cities = _detect_cities(request_text, country)

    # -- Experiences --
    exp_flt: dict = {}
    if country:
        exp_flt["country"] = country
    if cities:
        # Boost city matches via a separate query, then merge.
        city_flt = {**exp_flt, "city": {"$in": cities}}
        city_exps = await db.experiences.find(city_flt, {"_id": 0}).limit(80).to_list(80)
    else:
        city_exps = []
    rest_exps = await db.experiences.find(exp_flt, {"_id": 0}).limit(150).to_list(150)
    seen_exp = {e["experience_id"] for e in city_exps}
    exps = list(city_exps)
    for e in rest_exps:
        if e["experience_id"] not in seen_exp:
            exps.append(e)
            if len(exps) >= 120:
                break
    # Final fallback when the country filter is too tight (rare destinations).
    if len(exps) < 20:
        more = await db.experiences.find({}, {"_id": 0}).limit(60).to_list(60)
        seen_exp = {e["experience_id"] for e in exps}
        for e in more:
            if e["experience_id"] not in seen_exp:
                exps.append(e)
                if len(exps) >= 80:
                    break

    # -- Hotels --
    hotel_flt: dict = {}
    if country:
        hotel_flt["country"] = country
    if cities:
        city_hotels = await db.hotels.find(
            {**hotel_flt, "city": {"$in": cities}}, {"_id": 0}
        ).limit(60).to_list(60)
    else:
        city_hotels = []
    rest_hotels = await db.hotels.find(hotel_flt, {"_id": 0}).limit(80).to_list(80)
    seen_h = {h.get("hotel_id") for h in city_hotels}
    hotels = list(city_hotels)
    for h in rest_hotels:
        if h.get("hotel_id") not in seen_h:
            hotels.append(h)
            if len(hotels) >= 80:
                break
    if len(hotels) < 10:
        more_h = await db.hotels.find({}, {"_id": 0}).limit(60).to_list(60)
        seen_h = {h.get("hotel_id") for h in hotels}
        for h in more_h:
            if h.get("hotel_id") not in seen_h:
                hotels.append(h)
                if len(hotels) >= 40:
                    break

    # Pull TRAINING examples by semantic similarity (TF-IDF over client_request),
    # FILTERED to the detected country so the AI doesn't mix Italy trips into a
    # Portugal draft. Falls back to recency if the index is still empty.
    retriever = await get_retriever(db)
    sold = retriever.top_k(request_text, k=5, prefer_outcomes=["sold"], min_score=0.05)
    not_sold = retriever.top_k(request_text, k=2, prefer_outcomes=["not_sold"], min_score=0.05)
    examples: list[dict] = sold + not_sold
    if country:
        # Keep only training examples whose request mentions the same country.
        country_kws = {k.lower() for k in _COUNTRY_KEYWORDS.get(country, [])}
        filtered = [
            ex for ex in examples
            if any(k in (ex.get("client_request") or "").lower() for k in country_kws)
        ]
        # If filtering left too few, keep the originals (better some inspiration
        # than none — but tag them so the prompt knows).
        if len(filtered) >= 2:
            examples = filtered
    if not examples:
        examples = await db.training_examples.find(
            {"outcome": {"$in": ["sold", "not_sold"]}, "client_request": {"$nin": [None, ""]}},
            {"_id": 0},
        ).sort("created_at", -1).limit(5).to_list(5)
    retrieval_meta = {
        "country": country,
        "cities": cities,
        "matched_sold": len(sold),
        "matched_not_sold": len(not_sold),
        "examples_used": len(examples),
        "experiences_in_context": len(exps),
        "hotels_in_context": len(hotels),
        "top_score": (examples[0].get("_score") if examples and examples[0].get("_score") is not None else None),
    }

    user_prompt_parts = [
        f"NEW CLIENT REQUEST:\n{request_text}",
        "",
        (
            f"DETECTED CONTEXT — country={country or 'unknown'} · cities={', '.join(cities) if cities else 'none'}.\n"
            f"All library items and past examples below are PRE-FILTERED to this destination, "
            f"so you can trust them to be geographically relevant."
        ),
        "",
        "EXPERIENCE LIBRARY (pick from these whenever possible):",
        _compact_json([_summ_experience(e) for e in exps]),
        "",
        "HOTEL LIBRARY (pick from these for accommodations):",
        _compact_json([_summ_hotel(h) for h in hotels]),
        "",
    ]
    if examples:
        user_prompt_parts.append(
            "PAST EXAMPLES (semantically similar, learn from these patterns).\n"
            "STUDY the SOLD ones to replicate what worked, COMPARE with the NOT_SOLD ones "
            "to avoid what failed. Each one is annotated with its outcome and similarity score."
        )
        for ex in examples:
            client_struct = ex.get("itinerary_structured")
            ops_struct = ex.get("itinerary_structured_ops")
            blocks = []
            # Prefer structured forms (much more token-efficient than raw text).
            # If neither structure has days, fall back to a TRUNCATED raw snippet.
            if client_struct and isinstance(client_struct, dict) and client_struct.get("days"):
                blocks.append(f"CLIENT-FACING ITINERARY (Travefy):\n{_compact_json(client_struct)}")
            if ops_struct and isinstance(ops_struct, dict) and ops_struct.get("days"):
                blocks.append(f"INTERNAL OPS VIEW (providers + real margins):\n{_compact_json(ops_struct)}")
            if not blocks and ex.get("itinerary_text_ops"):
                blocks.append(f"INTERNAL OPS VIEW (raw, truncated):\n{ex['itinerary_text_ops'][:1200]}")
            elif not blocks and ex.get("itinerary_text"):
                blocks.append(f"CLIENT ITINERARY (raw, truncated):\n{ex['itinerary_text'][:1200]}")
            if not blocks:
                continue
            score = ex.get("_score")
            score_tag = f" similarity={score:.2f}" if isinstance(score, (int, float)) else ""
            user_prompt_parts.append(
                f"--- outcome={ex['outcome']}{score_tag} ---\n"
                f"CLIENT REQUEST:\n{ex['client_request'][:1000]}\n\n"
                + "\n\n".join(blocks)
            )
    user_prompt_parts.append("\nNow produce ONLY the JSON itinerary for the NEW CLIENT REQUEST above.")

    data = await _call_claude_json(SYSTEM_PROMPT_GENERATE, "\n".join(user_prompt_parts))

    # Build itinerary draft from AI output
    draft = _itinerary_from_ai(data, client_name or data.get("main_traveler", ""), user.email)
    if save:
        await db.itineraries.insert_one(dict(draft))  # avoid mutating draft with _id
    draft.pop("_id", None)
    return {"itinerary": draft, "ai_summary": data.get("summary", ""), "retrieval": retrieval_meta}


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
