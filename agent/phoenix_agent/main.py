"""Phoenix EDR Agent - FastAPI application."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pathlib import Path

from phoenix_agent.config import settings
from phoenix_agent.api import events, alerts, policy, health, rules
from phoenix_agent.dashboard import views as dashboard_views
from phoenix_agent.storage.database import init_db, close_db
from phoenix_agent.services.retention import start_retention_scheduler

logging.basicConfig(level=settings.log_level)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan - init DB and retention scheduler."""
    logger.info("Starting Phoenix EDR Agent on %s:%d", settings.host, settings.port)
    await init_db(settings.db_path)
    scheduler = await start_retention_scheduler(settings.retention_days)
    yield
    scheduler.cancel()
    await close_db()
    logger.info("Phoenix EDR Agent shut down")


app = FastAPI(
    title="Phoenix EDR Agent",
    version="1.0.0",
    description="Browser Endpoint Detection and Response Agent",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["*"],
)

# API routes
app.include_router(events.router, prefix="/api")
app.include_router(alerts.router, prefix="/api")
app.include_router(policy.router, prefix="/api")
app.include_router(health.router, prefix="/api")
app.include_router(rules.router, prefix="/api")

# Dashboard
app.include_router(dashboard_views.router)

static_dir = Path(__file__).parent / "dashboard" / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")
