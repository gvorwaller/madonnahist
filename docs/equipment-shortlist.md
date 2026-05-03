# Equipment Shortlist for Calendar Photography

**Project context:** ~60 years of handwritten monthly calendar pages (~720 pages, fragile aged paper). Goal is forensic-grade archival masters that will outlive the 2026 OCR pipeline, plus images that feed the Transkribus / Google Vision / Azure handwriting-recognition workers.

**Capture system:** Panasonic Lumix DC-G9 II (G9M2) + Olympus M.Zuiko 60mm f/2.8 macro, mounted horizontally on a tripod with the page on a vertical/tilted cradle. **Workflow B** — single workflow, no separate scanner. Conservation-lab standard arrangement.

**Pricing as of May 2026.** Verify before purchase — pro photo gear pricing drifts ±15% on sales.

---

## What You Already Have (Don't Re-Buy)

- **Panasonic Lumix DC-G9 II** body — 25.2 MP MFT sensor, 100 MP High Res mode, IBIS, electronic shutter
- **Olympus M.Zuiko ED 60mm f/2.8 Macro** — flat-field, 1:1, the right lens for this work
  - 46mm filter thread (confirmed)
  - Currently has a UV filter — remove it during scanning sessions; UV + CPL stacks degrade transmission
- **Vortex High Country tripod** — extends to ~65", stable enough for the G9 II + 60mm. The height is a feature here: a typical copy stand tops out at ~36–40", which is too short for the 60mm's ~46–51" working distance to a full calendar page.
- **Promediagear Katana Jr gimbal head** — overkill for this use (it's rated for 600mm super-telephoto wildlife rigs), but it works. **Will be used in horizontal orientation, not down-facing**, so the down-facing-stability question never arises.

---

## The Kit to Buy

Listed by purchase priority. Total at the recommended quality tier: **~$1,500–1,800**.

### 1. Lighting — two CRI 95+ LED panels with softboxes

The single biggest determinant of image quality and cross-session consistency. **Two panels** for cross-lighting at 45° from each side eliminates shadow gradients and self-glare from a single light source. CRI 95+ AND TLCI 95+ matters specifically because faded pencil and red ink are the failure modes of cheap LEDs.

**Recommended (pro tier):**
| Item | Qty | Price | Notes |
|---|---|---|---|
| **Aputure Amaran 100x S** Bi-Color COB | 2 | ~$299 ea | 100W, CRI 95+ / TLCI 97+, SSI(D56) 87+, 2700–6500K bicolor (set 5000K), Bowens mount, app control |
| **Aputure Light Dome SE** softbox (33") | 2 | ~$129 ea | Bowens mount, soft-enough light spread for documents, easy to set up |
| **Manfrotto 1052BAC** compact light stands | 2 | ~$60 ea | 7.7' max, sturdy enough for the panel + softbox combo |
| **Aputure 2.5m / 8.2' light stand bag** | 1 | ~$30 | Optional, makes setup/teardown faster |

**Subtotal: ~$1,000**

**Premium upgrade path** (only if the Amaran's color stability isn't tight enough across long sessions, which is unlikely): swap to **Nanlite Forza 60B II** ($349 each) or **Aputure LS 300X II** ($1099 each). Going beyond the Amaran 100x S into broadcast-grade is overkill for documents — it pays off for moving subjects and high-key product shots, not flat artwork.

**Color temperature setting**: **5000K** for both panels. Not 5600K (too cool for warm-toned aged paper), not 4000K (too warm — mistakes red ink for brown). 5000K is the standard for graphic arts and archival reproduction (it matches D50, the ISO 3664 viewing standard for prints).

### 2. Cross-Polarization Setup — eliminates surface glare entirely

This is the single highest-leverage technique in archival imaging, and a real camera + lens combo is the only way to do it. The CZUR ET MAX cannot do this; the iPhone cannot do this. You can.

| Item | Price | Notes |
|---|---|---|
| **Heliopan 46mm Slim SH-PMC Circular Polarizer** | ~$90–110 | Schott B270 glass, 16-layer multi-coating, brass mount. The *right* CPL for a 46mm thread on a flat-field macro. Cheaper alternatives (Hoya HD3, B+W F-Pro Kaesemann) are 90% as good for half the price — defensible if you want to save $50, but the Heliopan is the no-regrets answer. |
| **Rosco #7300 Linear Polarizing Filter** sheet, 17"×20" | ~$60 | One sheet, cut in half. Tape one half over each LED panel's softbox face. Lasts the life of the project. |
| **Gaffer tape**, 2" black | ~$20 | For attaching the Rosco sheets cleanly to the softbox fronts. Don't use blue painter's tape — the adhesive fails under continuous-LED heat. |

**Subtotal: ~$170–190**

**How cross-polarization works:** The linear polarizers on the lights polarize the source light. The CPL on the lens is rotated 90° relative to the lights. Surface glare (which preserves the source polarization) gets blocked. Diffuse reflection from the ink/paper (which depolarizes) passes through. Result: matte, glare-free pages even on glossy/laminated/varnished surfaces. Cost: ~2 stops of light. Trivial on continuous LED panels.

**Setup procedure once:** Mount the CPL on the lens. Aim camera at a glossy surface lit by both panels. Slowly rotate the CPL until reflections collapse to minimum. Lock that rotation with a tiny dab of nail polish on the filter ring (or just memorize the orientation marker). Done forever — no per-session re-tuning needed as long as panels and lens stay mounted in the same orientation.

### 3. Page Cradle / Document Easel — gentle support, no contact damage

Most monthly wall calendars are flat single sheets (often torn off a binding ring). Some may still be bound. The recommendation handles both.

**For flat single-sheet pages (the common case):**

| Item | Price | Notes |
|---|---|---|
| **Daige Pro-Easel 30"** | ~$200 | Solid graphic-arts pro easel, adjustable angle (vertical to ~30° tilt), corner clips, foam-lined work surface. The right tool for flat artwork up to ~30" tall. |

**For any bound calendars (V-cradle):**

| Item | Price | Notes |
|---|---|---|
| **Custom V-cradle from a local conservator/bookbinder** | $300–600 | Foam-core or museum-board V-cradle sized to the bound calendar's dimensions, with weighted polyethylene strapping or magnetic page holders. Talas (talasonline.com) sells preservation supplies; a local conservator can build to fit. |
| **OR: Foam-core DIY V-cradle**, museum-board + Filmoplast tape | ~$50 in materials | Acceptable if you've handled archival materials before. Conservation By Design publishes plans. |

If the calendars are uniformly flat (e.g., torn from binding rings already), **skip the V-cradle entirely** and just use the Daige.

**Subtotal: $200–800** depending on whether bound calendars exist.

### 4. Color Management

| Item | Price | Notes |
|---|---|---|
| **Calibrite ColorChecker Passport Photo 2** (CCPP2) | $119 (B&H) | Per-session reference frame: shoot one before each batch under that day's lighting. Lets the LLM cleanup stage normalize white balance/exposure across sessions years apart. **Non-negotiable** for a multi-year project. |
| **Calibrite Display Plus HL** monitor calibrator | ~$200 | Calibrates your Mac's display so what you see matches what's actually in the RAW. Critical when you'll be doing correction-UI work over years and the monitor will drift. |

**Subtotal: ~$320**

### 5. Tethered Capture Software & Workflow

**Important:** Neither Lightroom (CC or Classic) nor Capture One officially tethers the Panasonic G9 II. The G9 II's tethering tool is Lumix Tether — and that's actually fine.

**The workflow:**

1. **Lumix Tether** (free, official Panasonic) handles the tethered shoot — live view on the Mac, remote shutter from keyboard or app, full camera settings control, files save direct to a designated watched folder
2. **Lightroom Classic** auto-imports from that watched folder, applying a develop preset, metadata preset, and session keywords on import
3. Classic handles RAW processing, keywording (including hierarchical entity tags for people/places/events), and export of TIFFs/JPEGs to the OCR pipeline's input directory
4. Selected smart collections sync from Classic to **Lightroom CC** for cross-device viewing (iPad, iPhone, web) — useful for browsing/tagging away from the Mac, and for eventually sharing a curated view with Marcus or other family

**Recommended software:**

| Item | Cost | Role |
|---|---|---|
| **Lumix Tether** (Panasonic official) | Free | Capture tool — runs during shoots, saves RAWs to the watched folder |
| **Lightroom Classic** | $0 marginal (already owned) | Primary workflow: auto-import, RAW processing, keyword/metadata catalog, export to OCR pipeline. The "system of record" for the archive. |
| **Lightroom CC (1 TB Photography Plan)** | $0 marginal (already paying) | Secondary: receives synced smart collections from Classic for cross-device viewing. Not the source of truth — Classic is. |

**Why Classic as primary** (rather than CC): hierarchical keywords for entity tagging (`People > Family > Marcus` rolls up automatically), local-first catalog (the `.lrcat` file lives on your Mac — not in Adobe's cloud, so the archive's metadata isn't a hostage to subscription state), better watched-folder auto-import with develop/metadata presets, and multi-stage export presets for feeding the OCR pipeline. Classic was built for stock agencies and archives; CC was built for working photographers. This project fits Classic's design center.

**Setting up the dual-tool flow:**

1. In Classic: `File → Auto Import → Auto Import Settings` — point at the Lumix Tether output folder, set destination, develop preset (a starting baseline), metadata preset (your name + copyright + session date), and any auto-keywords (e.g., `madonnahist, calendar-archive, source:G9II`)
2. Build a smart collection like "Calendar Archive — Highlights" (rule: rated 3+ stars, or keyword `archive-share`)
3. Right-click the smart collection → "Sync with Lightroom" — it now appears in CC across iPad/iPhone/web
4. Originals stay local. CC just renders cloud-side previews of the synced collection.

**No subscription change needed** — your existing 1 TB Photography Plan covers both Classic and CC. Net new software cost for this project: **$0**.

**Cable**: a known-good USB-C cable rated for data + 5m active extension if your Mac is far from the tripod. **Tether Tools TetherPro USB-C to USB-C** ~$40, with their orange color so you don't mistake it for a charger cable.

### 6. Misc / Preservation

| Item | Price | Notes |
|---|---|---|
| **Hot-shoe bubble level** (Hama or Manfrotto) | ~$15 | Squaring the camera to the page is non-negotiable for horizontal capture. Visual estimation isn't tight enough; geared head adjustments without a level cause cumulative drift. |
| **Gaylord Sure-Grip cotton archival gloves**, 12 pairs | ~$10 | Skin oils on 1972 paper will discolor it over decades. Cheap insurance. |
| **Lineco archival polyester sleeves** for original pages | ~$25 / pack | Optional: store original calendar pages in archival sleeves after photographing. Worth it for the irreplaceable originals. |
| **Pencil-style anti-static brush** | ~$10 | Removes loose paper dust before each shot. A microfiber cloth pushes oils into the paper; a dry brush flicks dust off. |

**Subtotal: ~$60**

---

## Total Cost Summary

Adobe Photography Plan (1 TB) is already an active subscription, so software is $0 marginal for this project.

| Category | Up-front |
|---|---|
| Lighting (Aputure 100x S × 2, softboxes, stands) | ~$1,000 |
| Cross-polarization (Heliopan CPL + Rosco sheets + tape) | ~$170–190 |
| Page cradle (Daige Pro-Easel, V-cradle if needed) | $200–800 |
| Color management (ColorChecker + display calibrator) | ~$320 |
| Tethered capture (Lumix Tether free; LR Classic + CC already owned) | $0 |
| Cable + misc + preservation | ~$110 |
| **Total** | **~$1,800–2,400 up-front** |

If only flat single-sheet calendars exist (no bound), drop the V-cradle and the up-front total is ~$1,600.

---

## G9 II Capture Settings

Lock these into a Custom Mode (C1) on the dial so you can't fat-finger them mid-session.

- **Mode**: Manual exposure (M)
- **Resolution**: **High Res Mode** (Tripod, 80MP RAW). The reason you bought a G9 II for archival work. Free 4× upsampling on a static subject.
- **File**: **RAW only** (no JPEG copy — Lightroom Classic handles export)
- **Aperture**: **f/5.6** — the Olympus 60/2.8 is sharpest in the f/5.6–f/8 zone; past f/8 diffraction softens MFT images
- **ISO**: **200** (G9 II base ISO — lowest noise)
- **Shutter**: dictated by lighting. Aim for ~1/60 to ~1/125 with continuous LED panels at the recommended setup. Doesn't matter for static subjects on a tripod.
- **Shutter mode**: **Electronic shutter** (eliminates shutter shock entirely; also silent)
- **Self-timer**: 2 seconds, OR remote release via Lumix Tether
- **Focus**: **Manual focus**, set once per session by zooming into the page in 10× live view and adjusting focus ring until the ink is sharp. Autofocus on flat subjects with low-contrast handwriting is unreliable.
- **White balance**: **Manual**, custom set from the ColorChecker WB target as the first shot of each session. Don't trust auto WB across years.
- **Image stabilization**: **Off** when on a tripod (IBIS on a tripod can introduce motion, not reduce it)
- **Color profile**: **Standard** (you'll process from RAW; in-camera profile doesn't matter)

---

## Setup Geometry

```
                       ┌─────────────────────────┐
                       │                         │
                       │      LED panel          │
                       │   (with Rosco sheet     │
                       │    over softbox face)   │
                       │                         │
                       └─────────┬───────────────┘
                                 │ ~45°
                                 ▼
       ┌───────────┐    ┌─────────────────┐    ┌───────────┐
       │           │    │                 │    │           │
       │ G9 II +   │───▶│  Calendar page  │◀───│ LED panel │
       │ 60mm + CPL│    │  on cradle      │    │           │
       │ (tripod,  │    │                 │    │           │
       │ horizontal)│   │                 │    │           │
       └───────────┘    └─────────────────┘    └───────────┘
       ~50" working                              ~45° from
       distance                                  page normal
```

- Tripod aimed horizontally, camera level (bubble level on hot shoe)
- Page on cradle, vertical or angled 10-15° back, parallel to sensor plane
- Two LED panels at 45° from each side of the page, equal distance, equal output
- CPL on lens locked at the cross-polarization angle (rotated 90° from light polarizers)
- Working distance: ~50" lens-front-to-page for a 12-14" page width

---

## Per-Session Shooting Workflow

1. **Set up**: assemble lights, position tripod, mount camera, tether to Mac via Lumix Tether
2. **Power lights**: 5000K, equal output (use a light meter or histogram to match — drop one panel by one stop and confirm visible falloff, then back to balance)
3. **Test page**: place a sample page on the cradle. Confirm framing in live view (page edges + ~10% padding), confirm focus, confirm even illumination (no hot side, no shadow side)
4. **First frame: ColorChecker.** Place the Passport Photo 2 in the same plane as the page, fully lit. Capture one frame. File goes to `session-YYYY-MM-DD/colorchecker.dng`.
5. **Second frame: WB target** — capture one frame of just the WB target patch for in-camera custom WB
6. **Capture pages**: load page → trigger shutter via Lumix Tether → file lands on Mac → glance at preview → next page
7. **Naming convention**: `YYYY-MM_pageN.dng` (e.g., `1968-03_page1.dng`). Maps directly to `calendar_pages.year`/`.month`/`.page_image_path` in the DB.
8. **Per-session log**: a short notes file in each session folder — `session-2026-05-10.md` — recording lighting setup, panel power, anything unusual. Helps the LLM cleanup stage if a session's batch needs special handling.

---

## What to Skip (Overkill or Wrong Tool)

- **CZUR ET MAX** ($499) — original plan. Skip. The G9 II + 60mm + good lighting beats it on every dimension that matters for archival masters.
- **Copy stand** of any kind — your tripod is taller than any consumer copy stand and the 60mm needs the height
- **Tru Vue Optium Museum Acrylic** — irrelevant for horizontal capture; you don't need a glass weight
- **Capture One Pro** — doesn't tether the G9 II; its color-rendering edge over Lightroom is immaterial for handwritten documents on aged paper; you already own LR Classic + CC, which together handle every requirement of this project
- **Dedicated archival lighting** (Solux, Hive, Nanlux) — the Amaran 100x S is genuinely pro-grade; archival-specialty lighting is for museum display, not photography
- **Macro rail / focus stacking gear** — flat documents don't need focus stacking; the 60mm at f/5.6 has more than enough DoF for a flat plane
- **Adobe Photoshop subscription** — Capture One does everything you need; PS isn't required
- **A 30mm or 45mm macro alternative lens** — your 60mm is the better optic; the working-distance "problem" was solved by using a tripod instead of a copy stand

---

## Sources

- [Aputure Amaran 100x S product page](https://amarancreators.com/products/amaran-100x-s)
- [Aputure Amaran 100x S — Pro Photo Supply](https://prophotosupply.com/products/amaran-100x-s-bi-color-led-light)
- [Heliopan 46mm Slim SH-PMC CPL — Amazon](https://www.amazon.com/Heliopan-704640-Circular-Polarizer-Sh-Pmc/dp/B001EA3MIM)
- [Heliopan 46mm SH-PMC CPL product page](https://heliopan.com/circular-polarizer-sh-pmc-filter-heliopan-46mm-circular-polarizer-sh-pmc-camera-lens-filter/)
- [Rosco #7300 Polarizing Filter, 17"×20" sheet — B&H](https://www.bhphotovideo.com/c/product/45130-REG/Rosco_101073001720_Polarizing_7300_Filter.html)
- [Rosco Polarizing Filters product page](https://us.rosco.com/en/product/polarizing-filters)
- [Calibrite ColorChecker Passport Photo 2 — B&H ($119)](https://www.bhphotovideo.com/c/product/1649345-REG/calibrite_ccpp2_colorchecker_passport_photo_2.html)
- [Lumix Tether download (Panasonic official)](https://av.jpn.support.panasonic.com/support/global/cs/soft/download/d_lumixtether.html)
- [G9 II tethered recording (Panasonic operating instructions)](https://eww.pavc.panasonic.co.jp/dscoi/DC-G9M2/html/DC-G9M2_DVQP3010_eng/0143.html)
- [Adobe Lightroom Classic tethered camera support (Panasonic not natively supported)](https://helpx.adobe.com/lightroom-classic/kb/tethered-camera-support.html)
- [Adobe Lightroom CC overview](https://www.adobe.com/products/photoshop-lightroom.html)
- [Capture One supported cameras (G9 II not in tethering list)](https://support.captureone.com/hc/en-us/articles/360002718118-Camera-Models-and-RAW-Files-Supported-by-Capture-One)
- [Gaylord Archival Sure-Grip Cotton Gloves](https://www.gaylord.com/Preservation/Conservation-Supplies/Gloves/Sure-Grip-Cotton-Gloves-(12-Pairs)/p/HYB00484)
- [Talas conservation supplies (cradles, archival materials)](https://www.talasonline.com/)
