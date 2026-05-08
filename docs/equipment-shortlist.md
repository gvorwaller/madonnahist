# Equipment Shortlist for Calendar Photography

**Project context:** ~60 years of handwritten monthly calendar pages (~720 pages, fragile aged paper). Goal is forensic-grade archival masters that will outlive the 2026 OCR pipeline, plus images that feed the Transkribus / Google Vision / Azure handwriting-recognition workers.

**Capture system:** Panasonic Lumix DC-G9 II (G9M2) + Olympus M.Zuiko 60mm f/2.8 macro, mounted horizontally on a tripod with the page on a vertical/tilted cradle. **Workflow B** — single workflow, no separate scanner. Conservation-lab standard arrangement.

**Pricing as of May 2026.** Verify before purchase — pro photo gear pricing drifts ±15% on sales.

> **Design principle**: This system is optimized for repeatability and low-friction deployment in a shared living space. Setup speed and consistency are prioritized over maximum theoretical image quality. Two equipment tiers are documented below — a **Pro tier** (~$1,800) and a **Compact tier** (~$1,100–1,300); the dual-light 45° geometry, cross-polarization, ColorChecker, and tripod-based capture are mandatory in both.

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

**Page preparation:** All calendar pages will be cut from their binding at the top before scanning, producing flat single sheets. This eliminates the bound-calendar workflow entirely — every page is handled identically on the easel, no V-cradle, no binding-clearance issues, no per-calendar setup variation.

| Item | Price | Notes |
|---|---|---|
| **Daige Pro-Easel 30"** | ~$200 | Solid graphic-arts pro easel, adjustable angle (vertical to ~30° tilt), corner clips, foam-lined work surface. The right tool for flat artwork up to ~30" tall. Use the corner clips to hold any residual curl from previously-bound pages — gravity + clips beats glass weights every time. |

**Subtotal: ~$200**

**Cutting tools** (only if not already on hand): an Olfa rotary cutter (~$25), 18" cork-backed metal ruler (~$15), and a 24"×36" self-healing cutting mat (~$40) — ~$80 total — handle the page-separation prep cleanly. Cut close to the binding perforations but leave a clean margin; don't chase the binding holes themselves.

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
| **Drafting brush** (Alvin or Staedtler, ~12" wide, soft horsehair) | ~$15 | Removes loose paper dust before each shot — one or two light sweeps covers a 14×16" calendar page. A microfiber cloth pushes skin oils into the paper; a soft drafting brush flicks dust off without contact pressure. **Avoid stiff ESD/electronics brushes** — bristles designed for PCBs are too rigid for fragile aged paper and can lift fibers from the page itself. |

**Subtotal: ~$60**

---

## Compact Deployment Configuration ($1,100–1,300)

A second tier optimized for tighter budget and the smaller footprint of the small-space deployment. **Quality cost is bounded**: dual-light 45° geometry, cross-polarization, ColorChecker, manual WB, and tripod-based capture all carry over unchanged. Only panel wattage, softbox size, and CPL brand are downgraded. For 8.5"×11" calendar pages at ~50" working distance, 60W panels are bright enough for f/5.6 / ISO 200 / ~1/60s with margin to spare.

### What changes (vs. Pro tier)

| Component | Pro tier | Compact tier | Compact savings |
|-----------|----------|--------------|-----------------|
| Lighting panels | Aputure Amaran 100x S × 2 (~$598) | **Aputure Amaran 60x S** or **Godox SL60II Bi** × 2 (~$300) | ~$300 |
| Softboxes | Aputure Light Dome SE 33" × 2 (~$258) | 24–28" Bowens-mount softbox × 2 (~$140) | ~$118 |
| CPL filter | Heliopan 46mm Slim SH-PMC (~$100) | **Hoya HD3 46mm CPL** or **B+W F-Pro Kaesemann** (~$50) | ~$50 |
| Page support | Daige Pro-Easel 30" (~$200) | **Foamcore-backed rigid board + bulldog clips** on a tabletop easel (~$30) — or keep the Daige if the budget allows | ~$170 |
| Display calibrator | Calibrite Display Plus HL (~$200) | **Optional** — defer or skip; ColorChecker still required | ~$200 |

### What stays mandatory (no Compact downgrade)

- **Dual-light 45° geometry** — single-light setups produce shadow gradients that no software step can fully correct
- **Cross-polarization** — Rosco #7300 sheets on the lights + a CPL on the lens; the CPL brand is negotiable, the technique is not
- **Calibrite ColorChecker Passport Photo 2** — every session, every batch; this is what makes the archive normalizable across years
- **Manual white balance** — set per session from the ColorChecker, never auto WB
- **Tripod-based capture** — the G9 II + 60mm needs a stable platform for High Res Mode
- **Lightroom Classic workflow** — auto-import from the Lumix Tether watched folder, hierarchical keywords, local catalog

### Compact-tier cost breakdown

| Category | Compact cost |
|----------|--------------|
| Lighting (60W panels × 2, 24–28" softboxes, stands, bag) | ~$500 |
| Cross-polarization (Hoya CPL + Rosco sheets + gaffer tape) | ~$130 |
| Page support (rigid board + bulldog clips) | ~$30 |
| Color management (ColorChecker only; calibrator deferred) | ~$120 |
| Cable + misc + preservation | ~$110 |
| **Total** | **~$1,100–1,300 up-front** |

Keeping the Daige easel (worth it; one-time buy that lasts the project) and deferring the calibrator lands around $1,300. Dropping both lands ~$1,100.

### When to choose which tier

- **Choose Pro** if: budget allows; you want maximum optical margin; the lights will be reused for portraits, art reproduction, or video; or you want headroom for years-long workflow drift.
- **Choose Compact** if: budget is the binding constraint; the small-space deployment (60W is more than enough for a 5'×5' rig) is the actual setting; or you'd rather invest the ~$700 difference in archival storage / backup drives / OCR vendor credits.

The 60W panels are demonstrably sufficient for static documents at ~50" working distance. The Heliopan CPL is the only line item where the Pro tier offers a measurable optical advantage; on faded handwriting that the OCR will read either way, even that advantage is academic.

---

## Total Cost Summary

Adobe Photography Plan (1 TB) is already an active subscription, so software is $0 marginal for this project.

| Category | Pro tier | Compact tier |
|---|---|---|
| Lighting (panels + softboxes + stands + bag) | ~$1,000 | ~$500 |
| Cross-polarization (CPL + Rosco sheets + tape) | ~$170–190 | ~$130 |
| Page support | ~$200 (Daige Pro-Easel) | ~$30 (rigid board + clips) |
| Color management | ~$320 (ColorChecker + calibrator) | ~$120 (ColorChecker only) |
| Tethered capture (Lumix Tether free; LR Classic + CC already owned) | $0 | $0 |
| Cable + misc + preservation | ~$110 | ~$110 |
| **Total** | **~$1,800 up-front** | **~$1,100–1,300 up-front** |

Cutting tools (Olfa rotary cutter + ruler + cutting mat, ~$80) add to either tier if not already on hand.

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

## Small-Space Deployment (800 sq ft home)

The system lives in a shared dining/living area with zero permanent installation. Every session is a clean setup-and-teardown. The goals: hit the marks fast, get repeatable framing across sessions years apart, and never block the walk-through path to the kitchen.

### Constraints

- Full setup and teardown each session — no permanent rig
- Walk-through path to the kitchen preserved at all times
- Total usable footprint **5 ft × 5 ft** (operator zone)
- Equipment lightweight enough for one-person setup in under 10 minutes

### Fixed Floor Position System

A coordinate grid taped to the floor turns "set up the rig" into "put each foot on its mark." Repeatability across sessions becomes mechanical — no measuring, no guessing, no day-to-day drift in lighting angle or framing.

**Reference origin**: front-left corner of the dining table (nearest the piano).
**Axis convention**: X positive = right of the corner along the table edge. Y positive = into the room, away from the table edge.
**Marking material**: blue painter's tape with sharpie cross marks. Lifts cleanly, leaves no residue, re-mark once at the start of each year.

#### Tripod

- **Center**: X = -18", Y = 36"
- **Foot 1**: (-18, 30)
- **Foot 2**: (-26, 42)
- **Foot 3**: (-10, 42)

#### Lights

- **Left light stand base**: (-6, 18)
- **Right light stand base**: (46, 18)

#### Operator zone

- X = -20" to -10", Y = 48" to 60"

(Operator stands behind and slightly left of the tripod, with the Mac on a small rolling cart, side table, or chair within reach.)

### Table Alignment System

The page itself needs the same precision as the rig.

- **Page center**: (26", 16") — measured to the centerpoint of the easel/cradle face
- **Edge guides**: two corner brackets (3D-printed, or cut foamcore) taped to the table at fixed offsets from the page-center mark. Place every page into the same corners. No measuring per page; no creeping rotation across a session.

### Setup / Teardown Workflow

**Targets**: setup ≤ 8 minutes, teardown ≤ 5 minutes. If a session blows past these, something is wrong with the marks or the workflow — fix the system, not the session.

**Setup**:
1. Clear table (move centerpiece, mail, etc. to the piano top)
2. Place easel/cradle on the table edge guides
3. Move tripod to floor marks; extend to the marked height (record the leg-section height once and write it on the tripod leg)
4. Place light stands on floor marks; mount panels + softboxes; aim at the page (~45° each side)
5. **Close blinds fully** (see lighting control below)
6. Power on lights, set 5000K, equal output
7. Power on camera, connect Lumix Tether, confirm live view
8. Shoot ColorChecker frame + WB target frame
9. Begin capture

**Teardown**:
1. Power off lights and camera; cap lens
2. Disconnect tether cable; coil onto velcro reel
3. Remove softboxes from panels (they collapse fast); panels back to case
4. Collapse light stands; into stand bag
5. Collapse tripod (don't dismount the camera + lens — leave them on, in a padded case if room allows)
6. Lift easel; pages back into archival sleeves; everything to closet
7. Pull table edge guides if guests are coming; otherwise leave them — they're inert tape

### Lighting Control Requirement

**MANDATORY**: blinds fully closed during capture. **No mixed daylight + LED lighting.**

Daylight color temperature shifts from ~5500K (mid-morning) to ~4000K (late afternoon, overcast) to neutral-ish (north-facing diffuse). Mixing it with the 5000K LED panels means every session has a different color cast that can't be fully corrected from the ColorChecker because the mix ratio also varies. The CPL adds another wrinkle: ambient daylight bouncing off the page from the wrong angle isn't blocked by the cross-polarization (its polarization state is random), so glare control degrades.

Closed blinds is non-negotiable, not a preference. If the dining room has any direct-sun window, schedule sessions for after sunset for an extra margin.

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

---

## Ordering List

Organized by vendor so each batch can be a single cart/checkout. Prices verified May 2026 — confirm before ordering, photo gear pricing drifts ±15% on sales. Quantities and links provided for one-click navigation.

> **Tier note**: Listed items are the **Pro tier**. If going **Compact tier** (~$1,100–1,300, see [Compact Deployment Configuration](#compact-deployment-configuration-1100-1300) above), substitute line by line: Aputure 100x S → 60x S (~$150 ea), Light Dome SE 33" → 24–28" Bowens softbox (~$70 ea), Heliopan 46mm CPL → Hoya HD3 46mm (~$50), Daige Pro-Easel → foamcore + bulldog clips (~$30), Display Plus HL → defer/skip. Everything else (Rosco sheets, ColorChecker, stands, cable, gloves, tape, sleeves) stays the same.

### Order 1 — B&H Photo (largest cart, photo specialist)

B&H is the right default for this list: no sales tax for most states (NY only), reliable stock on archival/pro gear, and they package multi-line orders together. Place this order first.

> **Availability verified 2026-05-06.** All items below confirmed in stock at B&H Photo as of this date. Discontinued items from prior versions of this list (Aputure Light Dome SE — replaced by Aputure Quick Dome at the same B&H product slot; "Aputure 8.2' light stand bag" — not actually stocked at B&H under that name, replaced with Manfrotto LBAG90) have been swapped to current equivalents. Prices/links should still be re-verified at checkout — photo gear pricing drifts ±15%.

| ✓ | Item | Qty | Unit | Total | Link |
|---|------|-----|------|-------|------|
| ☐ | Aputure amaran COB 100x S Bi-Color LED Monolight | 2 | $299 | $598 | [B&H 1753603-REG](https://www.bhphotovideo.com/c/product/1753603-REG/amaran_apm021xa10_cob_100x_s_bi_color.html) |
| ☐ | Aputure Quick Dome 33" softbox (Bowens mount) — official replacement for Light Dome SE | 2 | $129 | $258 | [B&H 1622464-REG](https://www.bhphotovideo.com/c/product/1622464-REG/aputure_amolightdomese_lantern_90.html) |
| ☐ | Manfrotto 1052BAC Alu Air-Cushioned Compact Stand (7.7') | 2 | $95 | $190 | [B&H 609058-REG](https://www.bhphotovideo.com/c/product/609058-REG/Manfrotto_1052BAC_1052BAC_Alu_Air_Cushioned.html) |
| ☐ | Manfrotto LBAG90 Quick Stack Light Stand Bag (replaces unavailable Aputure bag) | 1 | $40 | $40 | [B&H 682757-REG](https://www.bhphotovideo.com/c/product/682757-REG/Manfrotto_LBAG90_LBAG90_4_Quick_Stack.html) |
| ☐ | Heliopan 46mm Slim Circular Polarizer SH-PMC | 1 | $100 | $100 | [B&H 399985-REG](https://www.bhphotovideo.com/c/product/399985-REG/Heliopan_704640_46mm_SH_PMC_Circular_Polarizer.html) |
| ☐ | Rosco Polarizing #7300 Filter (17"×20" sheet) | 1 | $60 | $60 | [B&H 45130-REG](https://www.bhphotovideo.com/c/product/45130-REG/Rosco_101073001720_Polarizing_7300_Filter.html) |
| ☐ | Calibrite ColorChecker Passport Photo 2 | 1 | $119 | $119 | [B&H 1649345-REG](https://www.bhphotovideo.com/c/product/1649345-REG/calibrite_ccpp2_colorchecker_passport_photo_2.html) |
| ☐ | Calibrite Display Plus HL Colorimeter (current price $379, was $200 — see note) | 1 | $379 | $379 | [B&H 1770372-REG](https://www.bhphotovideo.com/c/product/1770372-REG/calibrite_ccdis3plhl_display_plus_hl.html) |
| ☐ | Tether Tools TetherPro USB-C to USB-C 15', orange | 1 | $40 | $40 | [B&H 1619202-REG](https://www.bhphotovideo.com/c/product/1619202-REG/tether_tools_cuc15rt_org_tetherpro_usb_c_to_usb_c.html) |
| ☐ | Manfrotto 337 2-Axis Hot Shoe Double Bubble Level | 1 | $20 | $20 | [B&H 263729-REG](https://www.bhphotovideo.com/c/product/263729-REG/Manfrotto_337_337_2_Axis_Flash_Hot.html) |
| ☐ | ProTapes Pro Gaffer Tape (2" × 30 yd, black) | 1 | $25 | $25 | [B&H 20009-REG](https://www.bhphotovideo.com/c/product/20009-REG/General_Brand_Gaffer_Cloth_Tape.html) |
| | | | **B&H subtotal** | **~$1,830** | |

**Notes on substitutions and price changes since previous draft:**

- **Aputure Light Dome SE → Aputure Quick Dome.** B&H's product slot 1622464-REG is now flagged "Replacement for Aputure Light Dome SE APA0218A30." The Quick Dome is Aputure's newer quick-folding circular Bowens softbox; functionally equivalent for cross-polarized document work, and the faster setup actually helps the small-space deployment workflow. Same ~33" diameter, same Bowens mount, same diffusion-fabric face. Buy this without hesitation.
- **Aputure 8.2' light stand bag → Manfrotto LBAG90.** Aputure does not currently stock a stand bag under that name at B&H; what came up in search were Light Storm transport bags (for the lights themselves, not stands). The Manfrotto LBAG90 holds 4 stands up to 35" collapsed — fits two 1052BAC stands with room for the tripod or accessories.
- **Manfrotto 1052BAC pricing:** the prior draft listed $60/each, which was an outdated estimate. Current B&H price is ~$95/each ($190 for two). Up $70 total.
- **Calibrite Display Plus HL pricing:** the prior draft listed $200, which was the *Display Pro HL* (sibling product). The **Plus HL** model is the right SKU for handling high-brightness displays (mini-LED, OLED) — current price is $379 at B&H. Up $179. **This is the largest single price correction.** If budget is tight, the Compact tier still defers this item entirely; the ColorChecker Passport remains the non-negotiable color-management piece.
- **Heliopan URL fix:** prior URL pointed at a non-existent SKU (704640 actually maps to 399985-REG at B&H, not 430946-REG). Same product, correct page now linked.

### Order 2 — Daige direct (or B&H if available)

| ✓ | Item | Qty | Unit | Total | Link |
|---|------|-----|------|-------|------|
| ☐ | Daige Pro-Easel 30" | 1 | $200 | $200 | [Daige](https://daige.com/products/pro-easel) |
| | | | **Daige subtotal** | **~$200** | |

### Order 3 — Gaylord Archival (preservation-specific)

| ✓ | Item | Qty | Unit | Total | Link |
|---|------|-----|------|-------|------|
| ☐ | Sure-Grip Cotton Gloves (12 pairs) | 1 | $10 | $10 | [Gaylord](https://www.gaylord.com/Preservation/Conservation-Supplies/Gloves/Sure-Grip-Cotton-Gloves-(12-Pairs)/p/HYB00484) |
| ☐ | Lineco archival polyester sleeves (letter or tabloid size, pick to fit pages) | 1 | $25 | $25 | [Gaylord](https://www.gaylord.com/Preservation/Storage/Polyester/) |
| | | | **Gaylord subtotal** | **~$35** | |

Gaylord and Talas both stock the polyester sleeves; either works. Talas tends to have more size options.

### Order 4 — Amazon (small misc)

| ✓ | Item | Qty | Unit | Total | Link |
|---|------|-----|------|-------|------|
| ☐ | Drafting brush (Alvin or Staedtler, ~12" wide, soft horsehair) | 1 | $15 | $15 | [Amazon](https://www.amazon.com/s?k=alvin+drafting+brush) |
| | | | **Amazon subtotal** | **~$15** | |

**Brush selection note:** Skip the wide ESD/anti-static brushes marketed for keyboards and PCBs (uxcell, Haojiaho, etc.). Those are designed for stiff electronics work; their bristles are too rigid for 60-year-old paper and can lift fibers from the page itself. The right tool is a soft-bristle drafting brush — same form factor (wide bench-brush shape, fast to sweep), but with horsehair or soft synthetic bristles meant for paper. Alvin and Staedtler are the established drafting-brush brands; either works.

### Order 5 — Cutting tools (only if not on hand)

Skip this whole section if you already own cutting equipment. Available at any of B&H, Amazon, Blick Art Materials, or Dick Blick.

| ✓ | Item | Qty | Unit | Total | Link |
|---|------|-----|------|-------|------|
| ☐ | Olfa 45mm rotary cutter | 1 | $25 | $25 | [Amazon](https://www.amazon.com/s?k=olfa+45mm+rotary+cutter) |
| ☐ | 18" cork-backed stainless steel ruler | 1 | $15 | $15 | [Amazon](https://www.amazon.com/s?k=18+inch+cork+backed+steel+ruler) |
| ☐ | 24"×36" self-healing cutting mat | 1 | $40 | $40 | [Amazon](https://www.amazon.com/s?k=24x36+self+healing+cutting+mat) |
| | | | **Cutting tools subtotal** | **~$80** | |

---

### Grand Total

| Order | Vendor | Subtotal |
|-------|--------|----------|
| 1 | B&H Photo | ~$1,830 |
| 2 | Daige direct | ~$200 |
| 3 | Gaylord Archival | ~$35 |
| 4 | Amazon | ~$15 |
| 5 | Cutting tools (optional) | ~$80 |
| | **Total (Pro tier)** | **~$2,075–2,155** |
| | **Total (Compact tier, B&H + same other vendors)** | **~$1,375–1,455** |

The Pro-tier total moved up from ~$1,805 to ~$2,075 primarily because the Display Plus HL re-prices to $379 and the 1052BAC re-prices to ~$95. If the calibrator is deferred (it's marked optional in the Compact tier and can be added later as the project matures), Pro-tier B&H drops to ~$1,450 and Pro-tier total to ~$1,696. **The ColorChecker Passport Photo 2 stays mandatory in either case.**

### Software (already owned — verify only)

| ✓ | Item | Status |
|---|------|--------|
| ☐ | Lumix Tether — confirm latest version installed on Mac | [Free download](https://av.jpn.support.panasonic.com/support/global/cs/soft/download/d_lumixtether.html) |
| ☐ | Lightroom Classic — confirm installed and licensed under existing 1 TB plan | Already paying |
| ☐ | Lightroom CC — confirm installed on Mac + iPad + iPhone for cross-device sync | Already paying |

### Ordering Notes

- **Place B&H first.** It's the bulk of the spend and they're the most reliable for stock + ship time. Once it ships, Daige and Gaylord can run in parallel — neither depends on B&H gear arriving first.
- **Verify the Heliopan thread size before ordering.** The Olympus 60mm f/2.8 is 46mm — confirmed in this doc, but worth a glance at the lens before checkout. A 49mm or 52mm CPL will not fit.
- **The Rosco sheet is one purchase for the project.** A single 17"×20" sheet cut in half covers both light panel softboxes. Don't order two.
- **Skip the Calibrite Display Plus HL** if you already have any recent ColorChecker or X-Rite display calibrator (i1Display Pro, Spyder X, etc.). Re-calibrating a known-good profile in a year is fine. The ColorChecker Passport Photo 2 is the non-skippable color-management item.
- **Aputure Amaran model name drift.** Aputure has rebranded the Amaran line a few times. If "Amaran 100x S" is out of stock, the equivalent successor (Amaran 100x or Amaran COB 100x S) at 100W bi-color with CRI 95+/TLCI 95+ is acceptable. Avoid the non-bi-color "100d" daylight-only versions — you want the ability to nudge color temperature.
- **Cradle alternate.** If Daige Pro-Easel 30" is out of stock or backordered, the Testrite #500 Lite Easel ($150-180) is a workable substitute with similar geometry.
