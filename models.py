"""
models.py — SQLAlchemy ORM models.

Tables:
  users          — one row per tracked email address
  website_visits — one row per domain + user (upserted on each ingest)
  page_visits    — one row per individual page/video visit (detailed tracking)
"""

import json
from datetime import datetime
from sqlalchemy import (
    Column, String, Integer, Float, DateTime, ForeignKey, Text
)
from sqlalchemy.orm import relationship
from database import Base


class User(Base):
    __tablename__ = "users"

    id          = Column(String, primary_key=True)
    name        = Column(String,  nullable=False)
    email       = Column(String,  nullable=False, unique=True)
    ip_address  = Column(String,  nullable=True)                  # last known public IP
    status      = Column(String,  default="offline")              # "online" | "offline"
    last_active = Column(String,  default="Never")

    # Aggregated totals (recalculated on every ingest)
    total_time_seconds = Column(Integer, default=0)
    total_websites     = Column(Integer, default=0)
    total_pages        = Column(Integer, default=0)
    total_clicks       = Column(Integer, default=0)
    avg_scroll_depth   = Column(Float,   default=0.0)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    visits      = relationship("WebsiteVisit", back_populates="user", cascade="all, delete-orphan")
    page_visits = relationship("PageVisit",    back_populates="user", cascade="all, delete-orphan")


class WebsiteVisit(Base):
    __tablename__ = "website_visits"

    id                 = Column(Integer, primary_key=True, autoincrement=True)
    user_id            = Column(String, ForeignKey("users.id"), nullable=False)
    domain             = Column(String, nullable=False)
    time_spent_seconds = Column(Integer, default=0)
    pages_visited      = Column(Integer, default=0)
    clicks             = Column(Integer, default=0)
    scroll_depth       = Column(Float,   default=0.0)
    bounce_rate        = Column(Float,   default=0.0)
    content_category   = Column(String,  default="Uncategorized")
    recorded_at        = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="visits")


class PageVisit(Base):
    """One row per individual page/video viewed by the user."""
    __tablename__ = "page_visits"

    id                 = Column(Integer, primary_key=True, autoincrement=True)
    user_id            = Column(String, ForeignKey("users.id"), nullable=False)
    domain             = Column(String,  nullable=False)
    full_url           = Column(String,  nullable=False)
    page_title         = Column(String,  nullable=True)
    content_type       = Column(String,  default="Webpage")   # "YouTube Video", "Article", "Webpage", etc.
    extra_info         = Column(Text,    nullable=True)        # JSON: {video_id, video_title, headline, ...}
    time_spent_seconds = Column(Integer, default=0)
    clicks             = Column(Integer, default=0)
    scroll_depth       = Column(Float,   default=0.0)
    visited_at         = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="page_visits")
