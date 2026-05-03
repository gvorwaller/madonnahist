# calendar-history-system.md

## 1. Overview

This system digitizes ~60 years of handwritten calendar entries into a structured, searchable, and explorable personal history.

Core goals:

- Capture high-quality images of calendar pages
- Extract handwritten text using AI-assisted OCR/HTR
- Provide a fast human correction workflow
- Store structured daily entries
- Enable search, timeline views, and AI-generated summaries
- Publish a private family-access web interface

---

## 2. Architecture (High-Level)

Local Capture (Mac/iPhone)
    ↓
Image Storage (disk)
    ↓
OCR / HTR Pipeline
    ↓
PostgreSQL (source of truth)
    ↓
Node/Express API
    ↓
React UI (Admin + Family Views)
    ↓
Cloudflare (edge, TLS, caching)

---

## 3. Tech Stack

### Backend
- Node.js (Express)
- PostgreSQL (native install, no Docker)
- pg (node-postgres)

### Frontend
- React
- Zustand (state management)

### Image Processing
- Sharp
- Optional OpenCV

### OCR / HTR Layer
- Transkribus
- Google Vision API
- Azure Document Intelligence

### Hosting
- DigitalOcean Droplet (2GB+)
- nginx reverse proxy
- Cloudflare

---

## 4. Data Model

### calendar_pages

CREATE TABLE calendar_pages (
  id SERIAL PRIMARY KEY,
  year INT,
  month INT,
  page_image_path TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

### calendar_days

CREATE TABLE calendar_days (
  id SERIAL PRIMARY KEY,
  page_id INT REFERENCES calendar_pages(id),
  entry_date DATE UNIQUE,
  day_image_path TEXT,
  ocr_initial_text TEXT,
  corrected_text TEXT,
  confidence_score FLOAT,
  correction_status TEXT,
  tags TEXT[],
  entities JSONB,
  ai_summary TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

---

## 5. OCR Pipeline

image → OCR → LLM cleanup → structured text → DB

---

## 6. Human Correction UI

[ Image ] | [ OCR ] | [ Corrected ]

Controls:
- Save
- Accept
- Next
- Tagging

---

## 7. AI Harness

Components:
- OCR Worker
- LLM Cleanup
- Entity Extractor
- Summary Generator

---

## 8. API

GET /days
POST /days/:id/correct
GET /timeline
GET /summary/year/:year

---

## 9. Deployment

nginx
Node
Postgres
Cloudflare

---

## 10. Phases

Phase 1: MVP
Phase 2: Search + UI
Phase 3: AI enrichment
Phase 4: Advanced automation

---

## 11. Goal

Searchable life archive + AI-generated narrative
