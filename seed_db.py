"""
seed_db.py — One-time script to populate the SQLite DB with the original mock data.
Run ONCE:  python seed_db.py
"""

from database import engine, SessionLocal, Base
import models   # registers all models with Base
from crud import get_or_create_user, upsert_website_visit, set_user_status

# Create all tables
Base.metadata.create_all(bind=engine)

# ── Mock data (identical to the original hardcoded data in main.py) ──────────

SEED_DATA = [
    {
        "name": "John Doe",
        "email": "john.doe@gmail.com",
        "status": "online",
        "last_active": "2 mins ago",
        "websites": [
            {"domain": "github.com",         "time": "1h 10m", "pages": 14, "clicks": 98,  "scroll": 85, "bounce": 12, "category": "Development"},
            {"domain": "stackoverflow.com",  "time": "45m",    "pages": 9,  "clicks": 67,  "scroll": 90, "bounce": 8,  "category": "Development"},
            {"domain": "youtube.com",        "time": "32m",    "pages": 6,  "clicks": 43,  "scroll": 55, "bounce": 30, "category": "Entertainment"},
            {"domain": "reddit.com",         "time": "20m",    "pages": 10, "clicks": 57,  "scroll": 78, "bounce": 22, "category": "Social"},
            {"domain": "medium.com",         "time": "13m",    "pages": 8,  "clicks": 47,  "scroll": 60, "bounce": 18, "category": "Reading"},
        ],
    },
    {
        "name": "Jane Smith",
        "email": "jane.smith@gmail.com",
        "status": "online",
        "last_active": "15 mins ago",
        "websites": [
            {"domain": "notion.so",      "time": "40m", "pages": 8,  "clicks": 55, "scroll": 70, "bounce": 10, "category": "Productivity"},
            {"domain": "figma.com",      "time": "35m", "pages": 6,  "clicks": 72, "scroll": 80, "bounce": 5,  "category": "Design"},
            {"domain": "dribbble.com",   "time": "20m", "pages": 9,  "clicks": 40, "scroll": 55, "bounce": 25, "category": "Design"},
            {"domain": "pinterest.com",  "time": "10m", "pages": 5,  "clicks": 20, "scroll": 45, "bounce": 40, "category": "Social"},
        ],
    },
    {
        "name": "Alex Kumar",
        "email": "alex.kumar@gmail.com",
        "status": "offline",
        "last_active": "1 hr ago",
        "websites": [
            {"domain": "linkedin.com",            "time": "50m", "pages": 12, "clicks": 80, "scroll": 60, "bounce": 15, "category": "Professional"},
            {"domain": "coursera.org",            "time": "40m", "pages": 7,  "clicks": 55, "scroll": 88, "bounce": 6,  "category": "Education"},
            {"domain": "news.ycombinator.com",    "time": "20m", "pages": 10, "clicks": 49, "scroll": 72, "bounce": 20, "category": "Tech News"},
            {"domain": "twitter.com",             "time": "20m", "pages": 6,  "clicks": 40, "scroll": 50, "bounce": 35, "category": "Social"},
        ],
    },
    {
        "name": "Priya Sharma",
        "email": "priya.sharma@gmail.com",
        "status": "online",
        "last_active": "Just now",
        "websites": [
            {"domain": "amazon.in",         "time": "55m",    "pages": 18, "clicks": 120, "scroll": 88, "bounce": 9,  "category": "E-Commerce"},
            {"domain": "netflix.com",       "time": "1h 30m", "pages": 8,  "clicks": 95,  "scroll": 72, "bounce": 5,  "category": "Entertainment"},
            {"domain": "instagram.com",     "time": "40m",    "pages": 20, "clicks": 115, "scroll": 90, "bounce": 7,  "category": "Social"},
            {"domain": "maps.google.com",   "time": "20m",    "pages": 16, "clicks": 100, "scroll": 68, "bounce": 12, "category": "Navigation"},
        ],
    },
]


def _human_to_seconds(time_str: str) -> int:
    """Convert '1h 30m', '45m', '2h' etc. to seconds."""
    total = 0
    parts = time_str.strip().split()
    for part in parts:
        if part.endswith("h"):
            total += int(part[:-1]) * 3600
        elif part.endswith("m"):
            total += int(part[:-1]) * 60
    return total


def seed():
    db = SessionLocal()
    try:
        for entry in SEED_DATA:
            user = get_or_create_user(db, email=entry["email"], name=entry["name"])

            # Set status / last_active directly (not via set_user_status to keep mock values)
            user.status      = entry["status"]
            user.last_active = entry["last_active"]
            db.commit()

            for site in entry["websites"]:
                upsert_website_visit(
                    db,
                    user_id=user.id,
                    domain=site["domain"],
                    time_spent_seconds=_human_to_seconds(site["time"]),
                    pages_visited=site["pages"],
                    clicks=site["clicks"],
                    scroll_depth=float(site["scroll"]),
                    bounce_rate=float(site["bounce"]),
                    content_category=site["category"],
                )

        print("[OK] Database seeded successfully!")
        all_users = db.query(models.User).all()
        for u in all_users:
            print(f"   {u.email}  |  visits: {u.total_websites}  |  time: {u.total_time_seconds}s")
    finally:
        db.close()


if __name__ == "__main__":
    seed()
