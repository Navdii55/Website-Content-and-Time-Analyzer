"""
crud.py — All database read/write helpers used by the FastAPI routes.
"""

import uuid
import json
from datetime import datetime, timezone
from sqlalchemy.orm import Session
from sqlalchemy import func
from models import User, WebsiteVisit, PageVisit


# ─────────────────────────────────────────────
#  Helpers
# ─────────────────────────────────────────────

def _seconds_to_human(seconds: int) -> str:
    """Convert a raw seconds count to a human-readable string like '1h 20m'."""
    if seconds <= 0:
        return "0m"
    h = seconds // 3600
    m = (seconds % 3600) // 60
    if h > 0 and m > 0:
        return f"{h}h {m}m"
    if h > 0:
        return f"{h}h"
    return f"{m}m"


def _recalculate_user_totals(db: Session, user: User) -> None:
    """Recompute aggregated columns on the User row from its WebsiteVisit rows."""
    visits = user.visits
    if not visits:
        user.total_time_seconds = 0
        user.total_websites     = 0
        user.total_pages        = 0
        user.total_clicks       = 0
        user.avg_scroll_depth   = 0.0
        return

    user.total_time_seconds = sum(v.time_spent_seconds for v in visits)
    user.total_websites     = len(visits)
    user.total_pages        = sum(v.pages_visited for v in visits)
    user.total_clicks       = sum(v.clicks for v in visits)
    depths = [v.scroll_depth for v in visits]
    user.avg_scroll_depth   = round(sum(depths) / len(depths), 1) if depths else 0.0


# ─────────────────────────────────────────────
#  User CRUD
# ─────────────────────────────────────────────

def get_or_create_user(db: Session, email: str, name: str, ip_address: str = None) -> User:
    """Return the existing user for this email, or create a new one. Always updates IP."""
    user = db.query(User).filter(User.email == email).first()
    if not user:
        user = User(
            id=str(uuid.uuid4()),
            email=email,
            name=name,
            ip_address=ip_address,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    else:
        # Always update the IP (it can change with DHCP)
        if ip_address and user.ip_address != ip_address:
            user.ip_address = ip_address
            db.commit()
    return user


def set_user_status(db: Session, user: User, status: str) -> None:
    """Mark a user online/offline and update last_active timestamp."""
    user.status      = status
    user.last_active = "Just now" if status == "online" else datetime.now(timezone.utc).strftime("%d %b %Y %H:%M")
    db.commit()


# ─────────────────────────────────────────────
#  WebsiteVisit CRUD
# ─────────────────────────────────────────────

def upsert_website_visit(
    db: Session,
    user_id: str,
    domain: str,
    time_spent_seconds: int,
    pages_visited: int,
    clicks: int,
    scroll_depth: float,
    bounce_rate: float,
    content_category: str,
) -> WebsiteVisit:
    """
    If a visit row for this user+domain already exists, accumulate the counters.
    Otherwise insert a new row. Then recalculate the user's aggregate totals.
    """
    visit = (
        db.query(WebsiteVisit)
        .filter(WebsiteVisit.user_id == user_id, WebsiteVisit.domain == domain)
        .first()
    )

    if visit:
        visit.time_spent_seconds += time_spent_seconds
        visit.pages_visited      += pages_visited
        visit.clicks             += clicks
        visit.scroll_depth        = max(visit.scroll_depth, scroll_depth)
        visit.bounce_rate         = round((visit.bounce_rate + bounce_rate) / 2, 1)
        visit.content_category    = content_category
        visit.recorded_at         = datetime.utcnow()
    else:
        visit = WebsiteVisit(
            user_id=user_id,
            domain=domain,
            time_spent_seconds=time_spent_seconds,
            pages_visited=pages_visited,
            clicks=clicks,
            scroll_depth=scroll_depth,
            bounce_rate=bounce_rate,
            content_category=content_category,
        )
        db.add(visit)
        db.flush()

    db.commit()
    db.refresh(visit)

    # Refresh user aggregates
    user = db.query(User).filter(User.id == user_id).first()
    if user:
        db.refresh(user)
        _recalculate_user_totals(db, user)
        db.commit()

    return visit


# ─────────────────────────────────────────────
#  PageVisit CRUD
# ─────────────────────────────────────────────

def create_page_visit(
    db: Session,
    user_id: str,
    domain: str,
    full_url: str,
    page_title: str = None,
    content_type: str = "Webpage",
    extra_info: str = None,
    time_spent_seconds: int = 0,
    clicks: int = 0,
    scroll_depth: float = 0.0,
) -> PageVisit:
    """Insert a new individual page visit record."""
    pv = PageVisit(
        user_id=user_id,
        domain=domain,
        full_url=full_url,
        page_title=page_title,
        content_type=content_type,
        extra_info=extra_info,
        time_spent_seconds=time_spent_seconds,
        clicks=clicks,
        scroll_depth=scroll_depth,
        visited_at=datetime.utcnow(),
    )
    db.add(pv)
    db.commit()
    db.refresh(pv)
    return pv


# ─────────────────────────────────────────────
#  Dashboard Queries
# ─────────────────────────────────────────────

def get_all_users_summary(db: Session) -> list[dict]:
    """Return summary row for every user (no website breakdown)."""
    users = db.query(User).all()
    result = []
    for u in users:
        result.append({
            "id":               u.id,
            "name":             u.name,
            "email":            u.email,
            "ip_address":       u.ip_address or "—",
            "total_time":       _seconds_to_human(u.total_time_seconds),
            "total_websites":   u.total_websites,
            "total_pages":      u.total_pages,
            "total_clicks":     u.total_clicks,
            "avg_scroll_depth": f"{u.avg_scroll_depth}%",
            "last_active":      u.last_active,
            "status":           u.status,
        })
    return result


def get_user_detail(db: Session, user_id: str) -> dict | None:
    """Return full user detail including per-site and per-page breakdown."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        return None

    websites = []
    for v in user.visits:
        websites.append({
            "domain":           v.domain,
            "time_spent":       _seconds_to_human(v.time_spent_seconds),
            "pages_visited":    v.pages_visited,
            "clicks":           v.clicks,
            "scroll_depth":     f"{v.scroll_depth}%",
            "bounce_rate":      f"{v.bounce_rate}%",
            "content_category": v.content_category,
        })

    # Latest 50 page visits, sorted newest first
    page_visits = []
    sorted_pvs = sorted(user.page_visits, key=lambda x: x.visited_at or datetime.min, reverse=True)[:50]
    for pv in sorted_pvs:
        extra = {}
        if pv.extra_info:
            try:
                extra = json.loads(pv.extra_info)
            except Exception:
                pass
        page_visits.append({
            "domain":           pv.domain,
            "full_url":         pv.full_url,
            "page_title":       pv.page_title or "—",
            "content_type":     pv.content_type,
            "extra_info":       extra,
            "time_spent":       _seconds_to_human(pv.time_spent_seconds),
            "clicks":           pv.clicks,
            "scroll_depth":     f"{pv.scroll_depth}%",
            "visited_at":       pv.visited_at.strftime("%d %b %Y %H:%M") if pv.visited_at else "—",
        })

    return {
        "id":               user.id,
        "name":             user.name,
        "email":            user.email,
        "ip_address":       user.ip_address or "—",
        "total_time":       _seconds_to_human(user.total_time_seconds),
        "total_websites":   user.total_websites,
        "total_pages":      user.total_pages,
        "total_clicks":     user.total_clicks,
        "avg_scroll_depth": f"{user.avg_scroll_depth}%",
        "last_active":      user.last_active,
        "status":           user.status,
        "websites":         websites,
        "page_visits":      page_visits,
    }


def get_kpis(db: Session) -> dict:
    """Return top-level aggregate KPIs across all users."""
    users              = db.query(User).all()
    total_time_seconds = sum(u.total_time_seconds for u in users)
    total_websites     = sum(u.total_websites for u in users)
    total_pages        = sum(u.total_pages for u in users)
    total_clicks       = sum(u.total_clicks for u in users)
    online_users       = sum(1 for u in users if u.status == "online")

    return {
        "total_users":      len(users),
        "online_users":     online_users,
        "combined_time":    _seconds_to_human(total_time_seconds),
        "total_websites":   total_websites,
        "total_pages":      total_pages,
        "total_clicks":     total_clicks,
        "tracking_status":  "Tracking Active",
    }
