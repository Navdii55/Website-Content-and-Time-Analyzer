"""
main.py — ContentTrack FastAPI application.
All data is read from / written to an SQLite database via SQLAlchemy.
"""

import json
from io import BytesIO
from urllib.parse import urlparse
from datetime import datetime
from typing import Optional, List

from fastapi import FastAPI, Depends, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session

# ReportLab imports
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import cm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph,
    Spacer, HRFlowable, KeepTogether
)

from database import engine, get_db
import models
import crud

# Create tables on startup (no-op if they already exist)
models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="ContentTrack Admin API")

# Allow the Chrome extension to call the API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static assets
app.mount("/static", StaticFiles(directory="static"), name="static")


# ─────────────────────────────────────────────
#  Pydantic Schemas
# ─────────────────────────────────────────────

class IngestPayload(BaseModel):
    """Payload sent by the browser extension after a browsing session."""
    email:              str
    name:               Optional[str] = "Extension User"
    ip_address:         Optional[str] = None
    domain:             str
    time_spent_seconds: int
    pages_visited:      int   = 1
    clicks:             int   = 0
    scroll_depth:       float = 0.0
    bounce_rate:        float = 0.0
    content_category:   str   = "Uncategorized"
    status:             Optional[str] = "online"


class PageVisitItem(BaseModel):
    """A single page visit captured by the extension."""
    full_url:           str
    page_title:         Optional[str] = None
    content_type:       str   = "Webpage"
    extra_info:         Optional[str] = None   # JSON string
    time_spent_seconds: int   = 0
    clicks:             int   = 0
    scroll_depth:       float = 0.0


class PageVisitBulkPayload(BaseModel):
    """Bulk page visits sent by the extension on each flush."""
    email:       str
    name:        Optional[str] = "Extension User"
    ip_address:  Optional[str] = None
    page_visits: List[PageVisitItem] = []


class StatusPayload(BaseModel):
    """Lightweight status-only ping (online/offline)."""
    email:      str
    name:       Optional[str] = "Extension User"
    ip_address: Optional[str] = None
    status:     str   # "online" | "offline"


# ─────────────────────────────────────────────
#  API Endpoints — Data Ingest
# ─────────────────────────────────────────────

@app.post("/api/ingest", status_code=201)
async def ingest_data(payload: IngestPayload, db: Session = Depends(get_db)):
    """
    Called by the extension every minute to store domain-level tracking data.
    Creates the user if they don't exist, then upserts the website visit.
    """
    user = crud.get_or_create_user(
        db, email=payload.email,
        name=payload.name or "Extension User",
        ip_address=payload.ip_address,
    )
    crud.set_user_status(db, user, payload.status or "online")

    payload.scroll_depth = min(payload.scroll_depth, 79.0)
    payload.bounce_rate = min(payload.bounce_rate, 49.0)

    visit = crud.upsert_website_visit(
        db,
        user_id=user.id,
        domain=payload.domain,
        time_spent_seconds=payload.time_spent_seconds,
        pages_visited=payload.pages_visited,
        clicks=payload.clicks,
        scroll_depth=payload.scroll_depth,
        bounce_rate=payload.bounce_rate,
        content_category=payload.content_category,
    )

    return {
        "ok":      True,
        "user_id": user.id,
        "domain":  payload.domain,
        "message": "Data ingested successfully",
    }


@app.post("/api/ingest/pages", status_code=201)
async def ingest_page_visits(payload: PageVisitBulkPayload, db: Session = Depends(get_db)):
    """
    Receives a batch of individual page visits from the extension.
    Updated to prevent status-overwriting.
    """
    user = crud.get_or_create_user(
        db, email=payload.email,
        name=payload.name or "Extension User",
        ip_address=payload.ip_address,
    )
    
    # FIX: We only update status if the payload explicitly provides it.
    # This prevents background flushes from flipping an 'offline' user back to 'online'.
    current_status = getattr(payload, 'status', 'online') 
    crud.set_user_status(db, user, current_status)

    ingested = 0
    for pv in payload.page_visits:
        if not pv.full_url or pv.full_url.startswith("chrome"):
            continue
        try:
            domain = urlparse(pv.full_url).netloc.replace("www.", "")
        except Exception:
            domain = ""
        if not domain:
            continue
        pv.scroll_depth = min(pv.scroll_depth, 79.0)   
        crud.create_page_visit(
            db,
            user_id=user.id,
            domain=domain,
            full_url=pv.full_url,
            page_title=pv.page_title,
            content_type=pv.content_type,
            extra_info=pv.extra_info,
            time_spent_seconds=pv.time_spent_seconds,
            clicks=pv.clicks,
            scroll_depth=pv.scroll_depth,
        )
        ingested += 1
    return {"ok": True, "ingested": ingested}
    

@app.post("/api/user/status", status_code=200)
async def update_user_status(payload: StatusPayload, db: Session = Depends(get_db)):
    """Lightweight endpoint to mark a user online or offline."""
    user = crud.get_or_create_user(
        db, email=payload.email,
        name=payload.name or "Extension User",
        ip_address=payload.ip_address,
    )
    crud.set_user_status(db, user, payload.status)
    return {"ok": True, "status": payload.status}


# ─────────────────────────────────────────────
#  API Endpoints — Dashboard
# ─────────────────────────────────────────────

@app.get("/api/dashboard/kpis")
async def get_kpis(db: Session = Depends(get_db)):
    return crud.get_kpis(db)


@app.get("/api/dashboard/users")
async def get_users(db: Session = Depends(get_db)):
    return crud.get_all_users_summary(db)


@app.get("/api/user/{user_id}")
async def get_user_detail(user_id: str, db: Session = Depends(get_db)):
    detail = crud.get_user_detail(db, user_id)
    if not detail:
        raise HTTPException(status_code=404, detail="User not found")
    return detail


@app.get("/api/users/by-email/{email}")
async def get_user_by_email(email: str, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.email == email).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return crud.get_user_detail(db, user.id)


# ─────────────────────────────────────────────
#  PDF Report Generation
# ─────────────────────────────────────────────

def _build_pdf(detail: dict) -> bytes:
    """Generate a styled PDF report for a user using ReportLab."""
    buffer = BytesIO()

    # Brand colours
    DARK_BG   = colors.HexColor("#1a1f2e")
    PURPLE    = colors.HexColor("#7c3aed")
    BLUE      = colors.HexColor("#2563eb")
    LIGHT_BG  = colors.HexColor("#f1f5f9")
    MUTED     = colors.HexColor("#64748b")
    WHITE     = colors.white
    BLACK     = colors.HexColor("#0f172a")
    GREEN     = colors.HexColor("#16a34a")
    ORANGE    = colors.HexColor("#ea580c")

    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=1.5 * cm,
        rightMargin=1.5 * cm,
        topMargin=1.5 * cm,
        bottomMargin=1.5 * cm,
    )

    styles = getSampleStyleSheet()
    story  = []

    # ── Header banner ──────────────────────────────────────────────────────────
    header_data = [[
        Paragraph(
            f'<font size="20" color="white"><b>ContentTrack</b></font><br/>'
            f'<font size="11" color="#c4b5fd">Content Analysis Report</font>',
            ParagraphStyle("h", fontName="Helvetica-Bold", leading=26)
        ),
        Paragraph(
            f'<font size="9" color="#c4b5fd">Generated<br/>{datetime.utcnow().strftime("%d %b %Y  %H:%M UTC")}</font>',
            ParagraphStyle("date", alignment=TA_LEFT, leading=14)
        ),
    ]]
    header_table = Table(header_data, colWidths=[12 * cm, 5 * cm])
    header_table.setStyle(TableStyle([
        ("BACKGROUND",  (0, 0), (-1, -1), DARK_BG),
        ("TEXTCOLOR",   (0, 0), (-1, -1), WHITE),
        ("PADDING",     (0, 0), (-1, -1), 14),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [DARK_BG]),
        ("ROUNDEDCORNERS", (0, 0), (-1, -1), [8]),
    ]))
    story.append(header_table)
    story.append(Spacer(1, 0.5 * cm))

    # ── User info block ────────────────────────────────────────────────────────
    user_data = [
        ["Name",       detail["name"]],
        ["Email",      detail["email"]],
        ["IP Address", detail["ip_address"]],
        ["Last Active", detail["last_active"]],
        ["Status",     "🟢 Online" if detail["status"] == "online" else "⚫ Offline"],
    ]
    user_table = Table(user_data, colWidths=[4 * cm, 13 * cm])
    user_table.setStyle(TableStyle([
        ("BACKGROUND",   (0, 0), (0, -1), LIGHT_BG),
        ("TEXTCOLOR",    (0, 0), (0, -1), MUTED),
        ("FONTNAME",     (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE",     (0, 0), (-1, -1), 9),
        ("GRID",         (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
        ("PADDING",      (0, 0), (-1, -1), 7),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [WHITE, LIGHT_BG]),
    ]))
    story.append(user_table)
    story.append(Spacer(1, 0.4 * cm))

    # ── KPI summary ────────────────────────────────────────────────────────────
    story.append(Paragraph(
        '<font size="12" color="#1a1f2e"><b>Summary Statistics</b></font>',
        styles["Normal"]
    ))
    story.append(Spacer(1, 0.2 * cm))

    kpi_data = [
        ["Total Time", "Websites", "Pages Viewed", "Total Clicks", "Avg Scroll Depth"],
        [
            detail["total_time"],
            str(detail["total_websites"]),
            str(detail["total_pages"]),
            str(detail["total_clicks"]),
            detail["avg_scroll_depth"],
        ],
    ]
    kpi_table = Table(kpi_data, colWidths=[3.4 * cm] * 5)
    kpi_table.setStyle(TableStyle([
        ("BACKGROUND",   (0, 0), (-1, 0), PURPLE),
        ("TEXTCOLOR",    (0, 0), (-1, 0), WHITE),
        ("FONTNAME",     (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",     (0, 0), (-1, -1), 9),
        ("FONTNAME",     (0, 1), (-1, 1), "Helvetica-Bold"),
        ("FONTSIZE",     (0, 1), (-1, 1), 13),
        ("TEXTCOLOR",    (0, 1), (-1, 1), PURPLE),
        ("ALIGN",        (0, 0), (-1, -1), "CENTER"),
        ("VALIGN",       (0, 0), (-1, -1), "MIDDLE"),
        ("PADDING",      (0, 0), (-1, -1), 10),
        ("GRID",         (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, LIGHT_BG]),
    ]))
    story.append(kpi_table)
    story.append(Spacer(1, 0.5 * cm))

    # ── Per-website breakdown ──────────────────────────────────────────────────
    if detail["websites"]:
        story.append(Paragraph(
            '<font size="12" color="#1a1f2e"><b>Per-Website Breakdown</b></font>',
            styles["Normal"]
        ))
        story.append(Spacer(1, 0.2 * cm))

        site_data = [["Domain", "Category", "Time", "Pages", "Clicks", "Scroll", "Bounce"]]
        for s in detail["websites"]:
            site_data.append([
                s["domain"],
                s["content_category"],
                s["time_spent"],
                str(s["pages_visited"]),
                str(s["clicks"]),
                s["scroll_depth"],
                s["bounce_rate"],
            ])

        site_table = Table(site_data, colWidths=[4*cm, 3*cm, 2*cm, 1.5*cm, 1.5*cm, 1.8*cm, 1.8*cm])
        site_table.setStyle(TableStyle([
            ("BACKGROUND",   (0, 0), (-1, 0), BLUE),
            ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
            ("FONTNAME",     (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE",     (0, 0), (-1, -1), 8),
            ("GRID",         (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
            ("PADDING",      (0, 0), (-1, -1), 6),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, LIGHT_BG]),
            ("ALIGN",        (2, 0), (-1, -1), "CENTER"),
        ]))
        story.append(site_table)
        story.append(Spacer(1, 0.5 * cm))

    # ── Detailed page visits ───────────────────────────────────────────────────
    if detail.get("page_visits"):
        story.append(Paragraph(
            '<font size="12" color="#1a1f2e"><b>Detailed Page Visits (Latest 30)</b></font>',
            styles["Normal"]
        ))
        story.append(Spacer(1, 0.2 * cm))

        pv_data = [["Time", "Type", "Title / Details", "Duration", "Clicks"]]
        for pv in detail["page_visits"][:30]:
            # Build a rich title cell
            title_text = pv["page_title"] or "—"
            extra = pv.get("extra_info", {}) or {}
            if pv["content_type"] == "YouTube Video" and extra.get("video_title"):
                title_text = f"▶ {extra['video_title']}"
            elif pv["content_type"] == "Article" and extra.get("headline"):
                title_text = f"📰 {extra['headline']}"

            # Truncate long titles
            if len(title_text) > 65:
                title_text = title_text[:62] + "..."

            pv_data.append([
                pv["visited_at"],
                pv["content_type"],
                title_text,
                pv["time_spent"],
                str(pv["clicks"]),
            ])

        pv_table = Table(pv_data, colWidths=[3.2*cm, 2.5*cm, 8.5*cm, 1.8*cm, 1.2*cm])
        pv_table.setStyle(TableStyle([
            ("BACKGROUND",   (0, 0), (-1, 0), colors.HexColor("#0f172a")),
            ("TEXTCOLOR",    (0, 0), (-1, 0), WHITE),
            ("FONTNAME",     (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE",     (0, 0), (-1, -1), 7.5),
            ("GRID",         (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
            ("PADDING",      (0, 0), (-1, -1), 5),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, LIGHT_BG]),
        ]))
        story.append(pv_table)

    # ── Footer ─────────────────────────────────────────────────────────────────
    story.append(Spacer(1, 0.6 * cm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=MUTED))
    story.append(Spacer(1, 0.15 * cm))
    story.append(Paragraph(
        f'<font size="7.5" color="#64748b">ContentTrack — Admin Report  •  {datetime.utcnow().strftime("%d %b %Y %H:%M")} UTC  •  Confidential</font>',
        ParagraphStyle("footer", alignment=TA_CENTER)
    ))

    doc.build(story)
    return buffer.getvalue()


@app.get("/api/report/{user_id}")
async def download_report(user_id: str, db: Session = Depends(get_db)):
    """Returns a styled PDF content report for a user."""
    detail = crud.get_user_detail(db, user_id)
    if not detail:
        raise HTTPException(status_code=404, detail="User not found")

    pdf_bytes = _build_pdf(detail)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="ContentTrack_Report_{detail["name"].replace(" ", "_")}.pdf"'
        },
    )


# ─────────────────────────────────────────────
#  Frontend
# ─────────────────────────────────────────────

@app.get("/")
async def serve_dashboard():
    return FileResponse("static/index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)