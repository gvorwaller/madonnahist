# Equipment Shortlist for Calendar Photography

**Project context:** ~60 years of handwritten monthly calendar pages (~720 pages, fragile aged paper). Goal is forensic-grade archival masters that will outlive the 2026 OCR pipeline, plus images that feed the Transkribus / Google Vision / Azure handwriting-recognition workers.

**Capture system:** Panasonic Lumix DC-G9 II (G9M2) + Olympus M.Zuiko 60mm f/2.8 macro, mounted horizontally on a tripod with the page on a vertical/tilted cradle. **Workflow B** — single workflow, no separate scanner. The arrangement borrows cross-polarization, neutral 5000K continuous lighting, ColorChecker-anchored color management, and per-session repeatability practices from cultural-heritage digitization standards (FADGI, NEDCC, Library of Congress), but this is a **home-practical setup**, not an institutional best-practice copy stand. See "Scope and Honesty Disclaimer" at the end of this doc for what's pragmatic vs. what's institutional.

**Pricing as of May 2026.** Verify every price and SKU at checkout — photo gear pricing drifts ±15% on sales, and individual SKUs can be discontinued or replaced quickly. Treat the line items below as **specifications first, specific products second**.

> **Design principle**: This system is optimized for repeatability and low-friction deployment in a shared living space. Setup speed and consistency are prioritized over maximum theoretical image quality. Two equipment tiers are documented below — a **Pro tier** (~$1,300–1,500 without display calibrator, ~$1,650–1,850 with) and a **Compact tier** (~$1,000–1,200); dual-light 45° geometry, cross-polarization, ColorChecker, manual white balance, and tripod-based capture are required in both.

> **Trust note (post-Codex review, 2026-05-08)**: an earlier draft of this doc contained a fabricated product reference (a "Daige Pro-Easel" that doesn't exist) and citations to several stale B&H product slots. A second-pass review with Codex caught these and other issues; this revision fixes them and adds explicit caveats where the original was overconfident. Where prices or SKUs are quoted, they were re-verified or removed; where techniques are described, claims have been softened to match what the cited authorities actually say. Always re-verify before ordering.

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

**Specifications first** (the Aputure line has rebranded twice in 2025-2026; pin specs, pick the current SKU at checkout):

- **2× LED COB monolights**, 100W class, **bi-color 2700-6500K** (settable 5000K), **CRI 95+ AND TLCI 95+**, Bowens mount, AC power, fan-cooled, app control desirable
- **2× 33"-class circular softbox**, Bowens mount, with diffusion fabric face
- **2× compact light stands**, ~7-8' max, air-cushioned
- **1× light stand bag**

**Recommended current products (verify at checkout):**

| Item | Qty | Price | Notes |
|---|---|---|---|
| **amaran Halo 100x** Bi-Color COB Monolight | 2 | ~$169 ea | Aputure's current 100W bi-color Bowens-mount COB. Replaces the discontinued amaran 100x S. CRI 96+ / TLCI 97+, 2700-6500K, Bowens mount, NFC/app control. |
| **Aputure 33"-class Bowens softbox** (Quick Dome 90, Light Dome SE if still stocked, or equivalent) | 2 | ~$130-220 ea | Aputure has been rotating SKUs in this size class. Any 33-35" circular Bowens softbox with a diffusion face works equivalently. |
| **Manfrotto 1052BAC** compact light stands | 2 | ~$90 ea | 7.7' max, air-cushioned, sturdy enough for the panel + softbox combo |
| **Manfrotto LBAG90** light stand bag | 1 | ~$40 | Holds 4 stands up to 35" collapsed |

**Subtotal: ~$840–1,040** (lighting is the most volatile part of this list — confirm at checkout)

**Why bi-color over daylight-only**: Aputure's "100d S" or pure-daylight variants are cheaper but lock you to one color temperature. Bi-color lets you set 5000K (graphic-arts standard) precisely, and gives flexibility if your room's wall color is shifting reflected light enough to need a slight nudge.

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

**Setup procedure (per session in a teardown workflow)**: Mount the CPL on the lens. Aim camera at a glossy surface lit by both panels. Slowly rotate the CPL until reflections collapse to minimum. Mark that rotation with a tiny dab of nail polish on the filter ring (or memorize the orientation marker). **Re-verify each session** by glancing at a glossy reference (a ColorChecker patch, a piece of laminated paper) in live view — if you see surface glare, your CPL has rotated or your panels have moved, and a 30-second tweak fixes it. The "set once, done forever" claim from earlier drafts of this doc was overstated for a setup that gets fully struck and re-deployed each session.

### 3. Page Cradle / Document Easel — gentle support, no contact damage

**Page preparation:** All calendar pages will be cut from their binding at the top before scanning, producing flat single sheets. This eliminates the bound-calendar workflow entirely — every page is handled identically on the easel, no V-cradle, no binding-clearance issues, no per-calendar setup variation.

| Item | Price | Notes |
|---|---|---|
| **Tabletop easel + foamcore backing + bulldog clips** (3-piece kit) | ~$50 | The right setup for flat-artwork capture, sourced as separate components: |
| ↳ U.S. Art Supply Cancun (or equivalent) tabletop easel, beechwood, ~23" canvas capacity | ~$30 | Holds the foamcore at the desired angle. Adjustable vertical to slight back-tilt, fits the small-space deployment. |
| ↳ 24"×30" black foamcore backing board | ~$15 | The actual page-mounting surface — gives you a true flat plane for the page (most tabletop easels have only a narrow bottom ledge, which won't keep aged/curled paper flat). Black reads as clean negative space behind the page in the captured frame. Replaceable when dinged. |
| ↳ Bulldog clips × 4 (medium, 1.25" capacity) | ~$5 | Hold the page flat against the foamcore at top corners and bottom corners. Beats glass weights and tape; doesn't touch the writing area. |

**Subtotal: ~$50**

**Note on the previous "Daige Pro-Easel" reference:** earlier drafts of this doc cited a Daige Pro-Easel at ~$200. That product is no longer available (Daige.com is dead, and search returns nothing). The 3-piece kit above is what's actually in stock and a better fit for the project anyway — the foamcore gives a true flat backing plane that a graphic-arts easel's bottom-ledge design doesn't.

**Cutting tools** (only if not already on hand): a **Carl DC-210N rotary trimmer** (15" cutting capacity, [rated 36 sheets of standard paper per Carl's spec](https://carl-officeproducts.com/product/dc-210n/), ~$70) plus a heavy-duty utility knife and steel ruler (~$25) for the initial through-stack cut.

**Stop conditions — read first.** The cutting workflow is destructive. **Do NOT cut** if any of the following apply; capture the bound page as-is instead, and decide later:

- The binding structure is unclear (cloth-bound, hand-bound, glued in a way you can't see)
- Pages are visibly brittle (corners crumble when handled, or paper resists folding without cracking)
- Handwritten content extends close to the binding edge — give yourself a generous margin
- The calendar has any historical/sentimental value beyond the dated content (e.g., bound by a family member, contains added physical attachments)
- You're unsure: **default to not cutting**. A bound page on the cradle still photographs fine; you can always cut later, but you can't uncut.

**Two-pass workflow (when the page is OK to cut):**

1. **Pass 1 — gross release** (heavy utility knife + steel ruler, on a sturdy surface): one cut through the full stack, just below the binding holes. This frees the pages from the binding strip without trying to be precise. *The DC-210N is rated for 36 sheets and could in principle handle a thin bound calendar in one pass, but a utility knife on a stable surface is safer for irreplaceable originals — you can see exactly where the cut is going and apply uniform pressure.*
2. **Pass 2 — clean even-up** (Carl DC-210N, one page at a time): each freed page goes through the trimmer at a fixed offset from the (now ragged) top edge, producing a consistent clean edge. Per-page handling protects against tear-instead-of-cut on aged paper that compresses unevenly when stacked.

If the binding is twin-loop wire (Wire-O), spiral, or stapled (saddle-stitched), **Pass 1 isn't needed** — the binding can be unfastened mechanically and pages slide off intact. Pass 2 still applies for trimming away the binding-hole row to a clean edge.

### 4. Color Management

| Item | Price | Notes |
|---|---|---|
| **Calibrite ColorChecker Passport Photo 2** (CCPP2) | ~$119 | The capture-side color anchor. Shoot one ColorChecker frame at the start of every session under that day's lighting. Lets the RAW-development stage normalize white balance/exposure across sessions years apart and gives the LLM cleanup stage a stable reference. **The single most important color-management item** in this list — buy this even if you skip everything else in this section. |
| **Calibrite Display Plus HL** monitor calibrator | ~$339 | Useful but optional. Calibrates your Mac display so what you see while reviewing/editing matches what's actually in the RAW. Helpful when correction-UI work spans years and a Mac monitor drifts, but not on the critical path for archival capture. **Defer if budget is tight** — the ColorChecker on every captured frame is what makes the archive recoverable; the display calibrator only affects how accurately you see it on screen. |

**Subtotal: ~$120–460** (capture target only ~$120; full kit with calibrator ~$460)

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

**Cable**: a known-good USB-C cable rated for data + 5m active extension if your Mac is far from the tripod. **Tether Tools TetherPro USB-C to USB-C, 15', orange** ~$60, with their distinctive orange color so you don't mistake it for a charger cable. (Generic USB-C cables routinely fail at >3m and may not deliver clean tethered data — the Tether Tools is one of the few cables sold specifically for this use case.)

### 6. Misc / Preservation

| Item | Price | Notes |
|---|---|---|
| **Hot-shoe bubble level** (Manfrotto 337 or Hama HA-5411) | ~$45 | Squaring the camera to the page matters for horizontal capture. Visual estimation isn't tight enough; geared head adjustments without a level cause cumulative drift. (Note: Manfrotto 337 has gone up in price — was ~$20, now ~$46. Hama HA-5411 is the cheaper alternative if available.) |
| **Lineco archival polyester sleeves** for original pages, sized for 14×16 (or larger) | ~$25 / pack | Optional but recommended: store the freed/photographed pages in archival polyester (Mylar / Melinex) sleeves before they go back in the closet. Polyester is chemically inert and protects against handling, dust, and humidity. Verify sizing against your largest page. |
| **Drafting brush** (Alvin or Staedtler, ~12" wide, soft horsehair) | ~$15 | Removes loose paper dust before each shot — one or two light sweeps cover the page. **Avoid stiff ESD/electronics brushes** for fragile aged paper. (Note: this is inferential, not a vendor-cited authority — soft-bristle brushes are the conservation-leaflet recommendation for surface cleaning per [NEDCC 6.1](https://www.nedcc.org/free-resources/preservation-leaflets/6.-conservation-procedures/6.1-surface-cleaning), but I have not seen ESD keyboard brushes specifically called out as harmful. The stiffer-bristle concern is judgment-based.) |

**Subtotal: ~$85**

**On gloves: don't wear them for paper.** Earlier drafts of this doc recommended cotton archival gloves "to prevent skin oils from discoloring paper over decades." That recommendation is **wrong** for paper records. Both [NARA Holdings Maintenance — Handling](https://www.archives.gov/preservation/holdings-maintenance/handling) and [Library of Congress — Caring for Books and Paper](https://www.loc.gov/preservation/care/handling.html) recommend **clean, dry hands** for handling paper records. Cotton gloves reduce dexterity, snag on torn edges, and increase the risk of mechanical damage to fragile pages — they cause more harm than the trace skin oils they prevent. Wash and thoroughly dry hands before each session; use nitrile gloves only if you're handling photo emulsions, contaminated material, or have hand lotion residue you can't fully wash off. **Do not order the cotton gloves.**

---

## Compact Deployment Configuration (~$1,000–1,200)

A second tier optimized for tighter budget and the smaller footprint of the small-space deployment. **Quality cost is bounded**: dual-light 45° geometry, cross-polarization, ColorChecker, manual WB, and tripod-based capture all carry over unchanged. Only panel wattage, softbox size, and CPL brand are downgraded. For 8.5"×11" calendar pages at ~50" working distance, 60W panels are bright enough for f/5.6 / ISO 200 / ~1/60s with margin to spare.

### What changes (vs. Pro tier)

| Component | Pro tier | Compact tier | Compact savings |
|-----------|----------|--------------|-----------------|
| Lighting panels | amaran Halo 100x × 2 (~$338) | **Amaran 60x S** or **Godox SL60II Bi** × 2 (~$300) | ~$40 |
| Softboxes | 33"-class Aputure Bowens softbox × 2 (~$260–440) | 24–28" Bowens-mount softbox × 2 (~$140) | ~$120–300 |
| CPL filter | Heliopan 46mm Slim SH-PMC (~$100) | **Hoya HD3 46mm CPL** or **B+W F-Pro Kaesemann** (~$50) | ~$50 |
| Page support | Tabletop easel + foamcore + bulldog clips (~$50) | Same — tabletop easel + foamcore + bulldog clips (~$50) | $0 |
| Display calibrator | Calibrite Display Plus HL (~$339) | **Defer** — ColorChecker still required | ~$339 |

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
| Page support (tabletop easel + foamcore + bulldog clips) | ~$50 |
| Color management (ColorChecker only; calibrator deferred) | ~$120 |
| Cable + misc + preservation | ~$110 |
| **Total** | **~$1,000–1,200 up-front** |

Page support is a one-time buy that's the same in both tiers — there's no Pro-tier upgrade path here. The single biggest budget lever is the Display Plus HL calibrator (~$339); deferring it brings Pro tier under $1,500.

### When to choose which tier

- **Choose Pro** if: budget allows; you want maximum optical margin; the lights will be reused for portraits, art reproduction, or video; or you want headroom for years-long workflow drift.
- **Choose Compact** if: budget is tight; the small-space deployment (60W is more than enough for a 5'×5' rig) is the actual setting; or you'd rather invest the difference in archival storage / backup drives / OCR vendor credits.

The 60W panels are demonstrably sufficient for static documents at ~50" working distance. The Heliopan CPL is the only line item where the Pro tier offers a measurable optical advantage; on faded handwriting that the OCR will read either way, that advantage is academic.

---

## Total Cost Summary

Adobe Photography Plan (1 TB) is already an active subscription, so software is $0 marginal for this project.

| Category | Pro tier | Compact tier |
|---|---|---|
| Lighting (panels + softboxes + stands + bag) | ~$840–1,040 | ~$500 |
| Cross-polarization (CPL + Rosco sheets + tape) | ~$185 | ~$130 |
| Page support (tabletop easel + foamcore + clips) | ~$50 | ~$50 |
| Color management | ~$120–460 (ColorChecker; calibrator optional) | ~$120 (ColorChecker only) |
| Tethered capture (Lumix Tether free; LR Classic + CC already owned) | $0 | $0 |
| Cable + misc + preservation | ~$130 | ~$110 |
| **Total** | **~$1,325–1,865 up-front** | **~$1,000–1,200 up-front** |

The Pro-tier range is wider than earlier drafts because (a) softbox SKUs rotate and prices vary $130–220 ea, and (b) the Display Plus HL calibrator is now correctly framed as optional. Pro tier without the calibrator: ~$1,325–1,525. Pro tier with the calibrator: ~$1,665–1,865.

Cutting tools (Carl DC-210N rotary trimmer + heavy utility knife + steel ruler, ~$95) add to either tier if not already on hand. Two-pass workflow: utility-knife through-stack cut to free pages from binding, then trimmer per-page for a clean even edge.

---

## G9 II Capture Settings

Lock these into a Custom Mode (C1) on the dial so you can't fat-finger them mid-session.

- **Mode**: Manual exposure (M)
- **Resolution**: **High Res Mode** (Tripod, **11552 × 8672 ≈ 100 MP RAW**, per [Panasonic G9 II official specs](https://shop.panasonic.com/products/lumix-g9ii-mirrorless-camera-body)). The reason you bought a G9 II for archival work. Pixel-shift compositing on a static subject; well above any conceivable OCR or human-reading need.
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
- Working distance: **~50" lens-front-to-page for a 14" page width; ~58" for a 16"-tall page** on the 4:3 MFT sensor (the 60mm focal length × MFT crop = ~120mm full-frame equivalent, and a 14×16" page does not fit the 4:3 frame at the same working distance — the longer dimension drives the distance). **Validate with a framing test against your actual largest page** before locking the tripod position. The Setup Geometry diagram and the Small-Space floor coordinates below assume the larger page dimension is governing; if your calendars are smaller, you can move closer.

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

> **The coordinates below are starting points, not gospel.** The numbers were sized for a 14" page width at a ~50" working distance. **Run a framing test with your actual largest calendar page before laying down tape**: place the page on the easel, set the tripod position by eye until the page fills the frame with ~10% padding, mark the actual tripod feet at that position, then derive the rest from there. The light positions and operator zone scale with the tripod position; adjust proportionally. Once tested and locked, the marks become mechanical for every subsequent session.

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

**Strongly recommended**: blinds fully closed during capture. **Avoid mixed daylight + LED lighting.**

Daylight color temperature shifts from ~5500K (mid-morning) to ~4000K (late afternoon, overcast) to neutral-ish (north-facing diffuse). Mixing it with the 5000K LED panels means every session has a different color cast. A single ColorChecker frame at the start of the session can correct **the average mix at that moment** but cannot fully correct **spatial variation** (e.g., a window-side hot spot vs. a shadowed side of the page) or temporal variation (mix ratio changing during a long session as the sun moves). The CPL adds another wrinkle: ambient daylight bouncing off the page from the wrong angle isn't blocked by the cross-polarization (its polarization state is random), so glare control degrades.

The institutional best practice ([FADGI 3rd Edition](https://www.digitizationguidelines.gov/guidelines/FADGI%20Technical%20Guidelines%20for%20Digitizing%20Cultural%20Heritage%20Materials_3rd%20Edition_05092023.pdf) §6) is **controlled, repeatable illumination** — meaning closed blinds, fixed panels, and a known-state color profile. Closed blinds is the easy way to meet that bar in a home setup. If the dining room has any direct-sun window, schedule sessions for after sunset for an extra margin.

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

### Cultural-heritage digitization standards (added post-Codex review)

- [FADGI Technical Guidelines for Digitizing Cultural Heritage Materials, 3rd Edition (2023)](https://www.digitizationguidelines.gov/guidelines/FADGI%20Technical%20Guidelines%20for%20Digitizing%20Cultural%20Heritage%20Materials_3rd%20Edition_05092023.pdf) — the institutional reference for cultural-heritage still-image capture
- [Library of Congress — Caring for Books and Paper (Handling)](https://www.loc.gov/preservation/care/handling.html) — paper-handling guidance (clean dry hands, not gloves)
- [NARA — Holdings Maintenance: Handling](https://www.archives.gov/preservation/holdings-maintenance/handling) — same, federal-archives-side guidance
- [NEDCC Preservation Leaflet 6.1 — Surface Cleaning of Books and Paper](https://www.nedcc.org/free-resources/preservation-leaflets/6.-conservation-procedures/6.1-surface-cleaning) — soft-brush surface cleaning
- [NEDCC Preservation Leaflet 6.6 — Digital Preservation](https://www.nedcc.org/free-resources/preservation-leaflets/6.-reformatting/6.6-digital-preservation) — file integrity, master/derivative separation
- [Library of Congress Digital Preservation — Personal Archiving](https://www.loc.gov/preservation/digital/) — personal archive backup strategy

### Equipment / capture system

- [Panasonic LUMIX G9 II official product page](https://shop.panasonic.com/products/lumix-g9ii-mirrorless-camera-body) — confirms 100MP High Res Mode (11552×8672), not 80MP as earlier drafts of this doc claimed
- [Heliopan 46mm SH-PMC CPL product page](https://heliopan.com/circular-polarizer-sh-pmc-filter-heliopan-46mm-circular-polarizer-sh-pmc-camera-lens-filter/)
- [Rosco Polarizing Filters product page](https://us.rosco.com/en/product/polarizing-filters)
- [Lumix Tether download (Panasonic official)](https://av.jpn.support.panasonic.com/support/global/cs/soft/download/d_lumixtether.html)
- [Adobe Lightroom Classic tethered camera support (Panasonic not natively supported)](https://helpx.adobe.com/lightroom-classic/kb/tethered-camera-support.html)
- [Adobe Lightroom Classic Auto Import help](https://helpx.adobe.com/lightroom-classic/help/import-photos-automatically.html) — the watched-folder workflow
- [Carl DC-210N Professional Rotary Trimmer specs](https://carl-officeproducts.com/product/dc-210n/) — 36-sheet capacity (not 10 as earlier drafts claimed)
- [PetaPixel: Amaran Halo Series Bi-Color COB Lights](https://petapixel.com/2026/03/06/amarans-new-halo-series-bi-color-cob-lights-start-at-just-119/) — confirms Halo line is the current Aputure 100W bi-color COB family
- [Talas conservation supplies (archival materials)](https://www.talasonline.com/) — alternate to Gaylord for polyester sleeves

### Color management standards

- [ISO 3664 (overview)](https://www.just-normlicht.com/detail/article/iso-3664.html) — D50 / 5000K is the graphic-arts viewing standard
- [Edmund Optics — Understanding Polarized Light](https://www.edmundoptics.com/knowledge-center/application-notes/optics/understanding-polarized-light/) — circular vs linear polarizers, technique fundamentals

### Sources removed in this revision

- ~~Aputure Amaran 100x S — Pro Photo Supply / amarancreators.com~~ — product discontinued, replaced by amaran Halo 100x
- ~~Capture One supported cameras~~ — irrelevant (we use Lumix Tether)
- ~~Gaylord Archival Sure-Grip Cotton Gloves~~ — recommendation reversed (don't wear gloves for paper)
- ~~Heliopan Amazon listing~~ — generic Amazon link superseded by manufacturer + B&H product page

---

## Ordering List

Organized by vendor so each batch can be a single cart/checkout. Prices verified May 2026 — confirm before ordering, photo gear pricing drifts ±15% on sales. Quantities and links provided for one-click navigation.

> **Tier note**: Listed items are the **Pro tier**. If going **Compact tier** (~$1,000–1,200), substitute line by line: amaran Halo 100x → Amaran 60x S or Godox SL60II Bi (~$150 ea), 33" Bowens softbox → 24–28" Bowens softbox (~$70 ea), Heliopan 46mm CPL → Hoya HD3 46mm (~$50), Display Plus HL → skip. Page support (tabletop easel + foamcore + bulldog clips), Rosco sheets, ColorChecker, stands, cable, tape, sleeves stay identical in both tiers. **No cotton gloves in either tier** — clean dry hands per NARA/LoC.

### Order 1 — B&H Photo (largest cart, photo specialist)

B&H is the right default for this list: no sales tax for most states (NY only), reliable stock on archival/pro gear, and they package multi-line orders together. Place this order first.

> **Re-verified 2026-05-08 after Codex review.** Every line below was checked. Two prior items pointed at discontinued/replacement B&H slots and have been corrected; multiple prices were stale or wrong and have been refreshed. **Verify each price and SKU at checkout** — the lighting line is the most volatile (Aputure has been rotating SKUs in 2025-2026), and B&H prices change without notice.

| ✓ | Item | Qty | Unit | Total | Link |
|---|------|-----|------|-------|------|
| ☐ | amaran Halo 100x Bi-Color LED Monolight (replaces discontinued amaran 100x S) | 2 | ~$169 | ~$338 | [B&H 1954192-REG](https://www.bhphotovideo.com/c/product/1954192-REG/amaran_mp0000043d_halo_100x_bi_color_led.html) |
| ☐ | Aputure 33"-class Bowens softbox (Quick Dome 90 / Light Dome SE if stocked / equivalent) | 2 | ~$130–220 | ~$260–440 | [Aputure softbox category](https://aputure.com/en-US/collections/softboxes-lanterns) — pick current SKU at checkout |
| ☐ | Manfrotto 1052BAC Alu Air-Cushioned Compact Stand (7.7') | 2 | ~$90 | ~$180 | [B&H 609058-REG](https://www.bhphotovideo.com/c/product/609058-REG/Manfrotto_1052BAC_1052BAC_Alu_Air_Cushioned.html) |
| ☐ | Manfrotto LBAG90 Quick Stack Light Stand Bag | 1 | ~$40 | ~$40 | [B&H 682757-REG](https://www.bhphotovideo.com/c/product/682757-REG/Manfrotto_LBAG90_LBAG90_4_Quick_Stack.html) |
| ☐ | Heliopan 46mm Slim Circular Polarizer SH-PMC (re-verify SKU at checkout) | 1 | ~$100 | ~$100 | [B&H 399985-REG](https://www.bhphotovideo.com/c/product/399985-REG/Heliopan_704640_46mm_SH_PMC_Circular_Polarizer.html) |
| ☐ | Rosco Polarizing #7300 Filter (17"×20" sheet) | 1 | ~$70 | ~$70 | [B&H 45130-REG](https://www.bhphotovideo.com/c/product/45130-REG/Rosco_101073001720_Polarizing_7300_Filter.html) |
| ☐ | Calibrite ColorChecker Passport Photo 2 | 1 | ~$119 | ~$119 | [B&H 1649345-REG](https://www.bhphotovideo.com/c/product/1649345-REG/calibrite_ccpp2_colorchecker_passport_photo_2.html) |
| ☐ | Calibrite Display Plus HL Colorimeter — **OPTIONAL** (defer if budget tight) | 0–1 | ~$339 | $0–339 | [B&H 1770372-REG](https://www.bhphotovideo.com/c/product/1770372-REG/calibrite_ccdis3plhl_display_plus_hl.html) |
| ☐ | Tether Tools TetherPro USB-C to USB-C 15', orange | 1 | ~$60 | ~$60 | [B&H 1619202-REG](https://www.bhphotovideo.com/c/product/1619202-REG/tether_tools_cuc15rt_org_tetherpro_usb_c_to_usb_c.html) |
| ☐ | Manfrotto 337 2-Axis Hot Shoe Double Bubble Level | 1 | ~$46 | ~$46 | [B&H 263729-REG](https://www.bhphotovideo.com/c/product/263729-REG/Manfrotto_337_337_2_Axis_Flash_Hot.html) |
| ☐ | ProTapes Pro Gaffer Tape (2" × 30 yd, black) | 1 | ~$15 | ~$15 | [B&H 20009-REG](https://www.bhphotovideo.com/c/product/20009-REG/General_Brand_Gaffer_Cloth_Tape.html) |
| | | | **B&H subtotal (without calibrator)** | **~$1,228–1,408** | |
| | | | **B&H subtotal (with calibrator)** | **~$1,567–1,747** | |

**Notes on changes from prior versions of this list (post-Codex review):**

- **Aputure 100x S → amaran Halo 100x.** The B&H slot I previously cited (1753603-REG) is a discontinued/replacement page, not a live product. The current SKU is the **amaran Halo 100x** at 1954192-REG, ~$169 (per [PetaPixel coverage](https://petapixel.com/2026/03/06/amarans-new-halo-series-bi-color-cob-lights-start-at-just-119/) of the Halo line launch). Same form factor, same Bowens mount, same 100W class, equivalent CRI.
- **"Aputure Quick Dome at $129 each" was wrong.** The B&H slot I previously cited (1622464-REG) is also a discontinued/replacement page; the linked replacement product is closer to ~$200 ea. Aputure rotates softbox SKUs frequently — the Light Dome SE, Light Dome III, Quick Dome, and Quick Dome 90 have all been the "current 33" Bowens" at various points in 2025-2026. Pick the current 33-35" Bowens-mount softbox at checkout from [Aputure's softbox collection](https://aputure.com/en-US/collections/softboxes-lanterns). Any reputable maker (Aputure, Godox, Glow, Profoto with adapter) works equivalently for cross-polarized document capture.
- **Prices refreshed across the table** based on Codex's checks 2026-05-08:
  - Manfrotto 1052BAC: ~$90 (was $95)
  - Rosco #7300: ~$70 (was $60)
  - Display Plus HL: ~$339 (was $379) — and **demoted to optional**
  - Tether Tools cable: ~$60 (was $40)
  - Manfrotto 337: ~$46 (was $20 — almost doubled)
  - ProTapes gaffer: ~$15 (was $25)
- **Heliopan SKU caveat.** The B&H product page at 399985-REG appears in search but Codex reported the URL dropped to a category page on direct fetch. The product is real (Heliopan US carries the same SKU); B&H may have temporarily delisted it. Verify the page is live before relying on this checkout step.
- **Display Plus HL demoted** from "critical" to optional. The capture-side ColorChecker Passport is what makes the archive recoverable; the display calibrator only affects how accurately you see the result on screen. Skip it without guilt if budget is tight.

### Order 2 — Amazon (page-support kit)

| ✓ | Item | Qty | Unit | Total | Link |
|---|------|-----|------|-------|------|
| ☐ | U.S. Art Supply Cancun Solid Wooden Tabletop Easel (beechwood, ~23" canvas capacity) | 1 | $30 | $30 | [Amazon](https://www.amazon.com/Art-Supply-Studio-Adjustable-Tabletop/dp/B01M6TLCSC) |
| ☐ | Black foamcore backing board, 24"×30" (or larger; 32"×40" also works) | 1 | $15 | $15 | [Amazon](https://www.amazon.com/s?k=24x30+black+foamcore+board) |
| ☐ | Bulldog binder clips, medium (1.25" capacity), pack of 12 | 1 | $5 | $5 | [Amazon](https://www.amazon.com/s?k=bulldog+binder+clips+medium+1.25) |
| | | | **Amazon (page support) subtotal** | **~$50** | |

### Order 3 — Gaylord Archival (preservation-specific)

| ✓ | Item | Qty | Unit | Total | Link |
|---|------|-----|------|-------|------|
| ☐ | Polyester (Mylar/Melinex) archival sleeves, sized for your largest page (verify dimensions before ordering) | 1 pack | ~$25 | ~$25 | [Gaylord polyester storage](https://www.gaylord.com/Preservation/Storage/Polyester/) (browse for the right size) |
| | | | **Gaylord subtotal** | **~$25** | |

**Sleeve sizing note**: the linked Gaylord page is a category, not a specific SKU — measure your largest cut calendar page first, then pick a sleeve at least 1" larger in each dimension. [Talas](https://www.talasonline.com/) carries the same polyester products and tends to have more size options. **Lineco** is one brand of archival polyester sleeve; "Mylar D" or "Melinex 516" are the technical product names that ensure archival quality (uncoated, archival polyester, no plasticizers).

**Cotton gloves removed from this order** (see Misc / Preservation section above) — paper records are handled with clean dry hands per NARA and Library of Congress guidance, not cotton gloves.

### Order 4 — Amazon (small misc)

| ✓ | Item | Qty | Unit | Total | Link |
|---|------|-----|------|-------|------|
| ☐ | Drafting brush (Alvin or Staedtler, ~12" wide, soft horsehair) | 1 | $15 | $15 | [Amazon](https://www.amazon.com/s?k=alvin+drafting+brush) |
| | | | **Amazon subtotal** | **~$15** | |

**Brush selection note:** Skip the wide ESD/anti-static brushes marketed for keyboards and PCBs (uxcell, Haojiaho, etc.). Those are designed for stiff electronics work; their bristles are too rigid for 60-year-old paper and can lift fibers from the page itself. The right tool is a soft-bristle drafting brush — same form factor (wide bench-brush shape, fast to sweep), but with horsehair or soft synthetic bristles meant for paper. Alvin and Staedtler are the established drafting-brush brands; either works.

### Order 5 — Cutting tools (only if not on hand, only if you've decided to cut)

Skip this whole section if you already own cutting equipment, **or** if you've decided not to cut pages from binding (see "Stop Conditions" in the Page Cradle section above). Two-pass workflow when cutting: utility knife for the gross through-stack release cut, rotary trimmer for the per-page clean even-up.

| ✓ | Item | Qty | Unit | Total | Link |
|---|------|-----|------|-------|------|
| ☐ | Carl DC-210N Professional Rotary Trimmer (15" cutting length, [36-sheet capacity](https://carl-officeproducts.com/product/dc-210n/)) | 1 | ~$70 | ~$70 | [Amazon B004I2KKGK](https://www.amazon.com/CARL-Professional-Trimmer-15-inch-capacity/dp/B004I2KKGK) |
| ☐ | Olfa LA-X heavy-duty utility knife (or equivalent — 25mm wide blade) | 1 | ~$15 | ~$15 | [Amazon search](https://www.amazon.com/s?k=olfa+heavy+duty+utility+knife+LA-X) |
| ☐ | 18" cork-backed stainless steel ruler | 1 | ~$15 | ~$15 | [Amazon search](https://www.amazon.com/s?k=18+inch+cork+backed+steel+ruler) |
| | | | **Cutting tools subtotal** | **~$100** | |

The cutting mat is no longer needed — the trimmer's built-in cutting strip handles Pass 2, and Pass 1 (utility knife on the binding edge) is done over a piece of cardboard or the cutting strip from an unused desk pad. If you want a mat for general project use, add a 24"×36" self-healing mat (~$40); not required for this workflow.

**Why the two-pass workflow despite the trimmer's 36-sheet capacity:** Earlier drafts of this doc claimed the DC-210N could only handle ~10 sheets and that's why you need a separate utility knife. **That was wrong** — Carl's spec is 36 sheets. The DC-210N can in principle cut a typical 12-page calendar in one pass. The reason to still use the utility knife for Pass 1 is **not capacity** but **safety on irreplaceable originals**: a hand-controlled utility knife on a stable surface lets you see exactly where the cut goes and apply uniform pressure. Aged paper compresses unevenly when stacked, and a single trimmer pass through 12 mixed-weight pages can produce torn-on-bottom-page failures that aren't recoverable. Per-page Pass 2 protects against that. (Codex flagged the original capacity claim — that fix has been applied here.)

---

### Grand Total

| Order | Vendor | Subtotal |
|-------|--------|----------|
| 1 | B&H Photo (without calibrator) | ~$1,228–1,408 |
| 1+ | B&H Photo (with calibrator) | ~$1,567–1,747 |
| 2 | Amazon (page support) | ~$50 |
| 3 | Gaylord Archival (sleeves only) | ~$25 |
| 4 | Amazon (drafting brush) | ~$15 |
| 5 | Cutting tools (optional, only if cutting) | ~$100 |
| | **Total (Pro tier without calibrator)** | **~$1,318–1,498** |
| | **Total (Pro tier with calibrator)** | **~$1,657–1,837** |
| | **Total (Compact tier)** | **~$1,000–1,200** |

The Pro tier dropped meaningfully from prior estimates because (a) Codex caught that the cited Aputure 100x S SKU was a discontinued slot — the current amaran Halo 100x is ~$169 ea, not $299; and (b) the Display Plus HL was correctly framed as optional. Pro tier without calibrator: ~$1,318–1,498 (a wider range than before reflecting honest uncertainty on softbox SKU pricing). **The ColorChecker Passport Photo 2 (~$119) stays the most important color-management item in either tier.** Glove line removed entirely (-$10).

### Software (already owned — verify only)

| ✓ | Item | Status |
|---|------|--------|
| ☐ | Lumix Tether — confirm latest version installed on Mac | [Free download](https://av.jpn.support.panasonic.com/support/global/cs/soft/download/d_lumixtether.html) |
| ☐ | Lightroom Classic — confirm installed and licensed under existing 1 TB plan | Already paying |
| ☐ | Lightroom CC — confirm installed on Mac + iPad + iPhone for cross-device sync | Already paying |

### Ordering Notes

- **Place B&H first.** It's the bulk of the spend and they're the most reliable for stock + ship time. Once it ships, the Amazon and Gaylord orders can run in parallel — neither depends on B&H gear arriving first.
- **Verify the Heliopan thread size before ordering.** The Olympus 60mm f/2.8 is 46mm — confirmed in this doc, but worth a glance at the lens before checkout. A 49mm or 52mm CPL will not fit.
- **The Rosco sheet is one purchase for the project.** A single 17"×20" sheet cut in half covers both light panel softboxes. Don't order two.
- **Skip the Calibrite Display Plus HL** if budget is tight or if you already own any recent display calibrator (i1Display Pro, Spyder X, etc.). The ColorChecker Passport Photo 2 is the more important color-management item; the calibrator can always be added later.
- **Aputure Amaran model name drift.** Aputure has rebranded the Amaran line aggressively in 2025-2026 (100x → 100x S → Halo 100x). Pick the **current 100W bi-color COB Bowens-mount monolight** with CRI 95+/TLCI 95+ at checkout. Avoid the non-bi-color "100d" daylight-only versions — you want the ability to nudge color temperature.
- **Lineco vs. generic polyester sleeves.** "Lineco" is one brand; the technical specifications that matter are **uncoated archival polyester** (Mylar D, Melinex 516, or equivalent), no plasticizers, no UV inhibitors. Any sleeve labeled "archival polyester" or "Mylar D" from Gaylord, Talas, or University Products meets that bar.
- **Page-support alternates.** If the U.S. Art Supply Cancun is out of stock, any beechwood A-frame tabletop easel rated for 18"+ canvas works (Pro Art, Mont Marte, Royal & Langnickel — all $25-40 on Amazon). The foamcore can be substituted with any rigid 24"×30" or larger flat board (gatorboard, mat board, even thin masonite painted matte black). The bulldog clips are commodity — any 1.25" capacity binder clip works.

---

## Paper Handling Guidance

This section was added after a Codex review caught the original doc recommending cotton gloves — which is **wrong** for paper records. Both NARA and Library of Congress are explicit: paper is handled with clean dry hands.

### Hands, not gloves

- **Wash hands and dry thoroughly** before each session. Soap residue, hand cream, and moisture all transfer to paper.
- **No lotions, oils, or cosmetics on the hands** during a session. If you've applied lotion in the last hour, re-wash and rinse longer than usual.
- **Cotton gloves reduce dexterity** — they snag on torn corners, and the resulting tear is far worse than the trace skin oils that gloves prevent. NARA: ["The Library of Congress and the National Archives do not require staff or researchers to wear gloves when handling paper records"](https://www.archives.gov/preservation/holdings-maintenance/handling).
- **Nitrile gloves are fine for special cases**: photo emulsions (silver gelatin, dye transfer), iron-gall ink that's unstable, suspected mold or contamination. Not for clean handwritten paper.
- **Avoid finger-pointing on the writing area.** Touch only the margins. If you have to grip more firmly (a stiff page wants to spring back), grip the page corners.

### Safe-to-touch areas

```
┌────────────────────────────────┐
│ ✓                            ✓ │  ← Top corners and edges
│                                │
│                                │
│                                │
│      [ writing area —          │
│         do not touch ]         │
│                                │
│                                │
│                                │
│ ✓                            ✓ │  ← Bottom corners and edges
└────────────────────────────────┘
```

### When to stop and call a conservator

If you see any of these on a particular page, stop and consult a paper conservator before proceeding (your local university library, state archives, or a [private member of the AIC Find a Conservator directory](https://www.culturalheritage.org/about-conservation/find-a-conservator) can help):

- Active mold (fuzzy growth, musty smell)
- Iron-gall ink that's eaten through the paper (the writing has corroded the page)
- Active flaking, crumbling at touch, or tear that propagates with normal handling
- Adhesive residue from old tape (especially yellow/amber stains)
- Fold lines that crack rather than flex

### Sources

- [NARA — Holdings Maintenance: Handling](https://www.archives.gov/preservation/holdings-maintenance/handling)
- [Library of Congress — Caring for Books and Paper](https://www.loc.gov/preservation/care/handling.html)
- [NEDCC Preservation Leaflet 6.1 — Surface Cleaning](https://www.nedcc.org/free-resources/preservation-leaflets/6.-conservation-procedures/6.1-surface-cleaning)

---

## Pilot Batch Protocol

Before buying the full kit and committing to a years-long workflow, **run a pilot batch** on 1-2 representative calendars. This validates framing, glare suppression, exposure, throughput, and the cutting/handling decisions before you've made any of them irreversible.

### Pilot batch goals

1. **Validate framing geometry** — does your largest page actually fit at the planned working distance? Adjust before laying floor tape.
2. **Validate cross-polarization extinction** — do the panels + sheets + CPL actually kill glare on a glossy reference? If extinction is weak, your panel alignment or sheet orientation is wrong.
3. **Validate exposure** — at f/5.6, ISO 200, 5000K, do you land somewhere in 1/30–1/250s? If under 1/30s the panels are too far away or output too low; if over 1/250s, too close or too bright.
4. **Validate cutting decisions** (if cutting) — does the binding type unfasten cleanly, or does Pass 1 require a destructive cut? Are pages brittle? Does any handwriting come close to the trim line?
5. **Validate throughput** — how long does a calendar (12-13 pages) actually take, end-to-end? Realistic estimates inform the project schedule.
6. **Validate the file pipeline** — does Lumix Tether → watched folder → LR Classic auto-import → preset application work as expected? Files named correctly, metadata applied, in the right collection?

### Pilot batch protocol

1. Set up the rig per the Setup Geometry section (with framing test).
2. Pick **one calendar** — pick a year that's not the most sentimentally important (so a mistake costs less if something goes wrong) but that has typical content (handwritten entries, mixed-density pages).
3. Capture all pages of that calendar end-to-end. Time the session.
4. Process the captured RAWs through your full pipeline (LR develop, export, OCR if applicable).
5. **Review on a calibrated screen** (or, lacking the calibrator, an iPad or Mac display set to the brightest setting in a dim room).
6. Inspect for: framing consistency, glare, sharpness corner-to-corner, color match across frames, color match against the original page side-by-side.
7. **Decide before scaling**: ship the workflow as-is, tweak specific parameters, or back up and re-evaluate.

If the pilot batch reveals problems, **stop and fix the workflow before continuing**. Re-shooting later is far harder than getting it right on the first try.

---

## Backup and File Integrity Strategy

A single-pass archive of irreplaceable family material **must** have a documented backup strategy. The cheapest mistake is to capture everything once, store it on a single drive, and lose it. The most expensive mistake is to discover years later that bit-rot silently corrupted half the files.

### 3-2-1 storage rule

The standard recommendation, applicable here:

- **3 copies** of every master file (the primary RAW + at least two backups)
- **2 different storage media** (e.g., a working SSD + an external HDD; not two SSDs of the same brand bought the same week)
- **1 copy off-site** (a different physical location: a relative's house, a safe deposit box, or cloud storage)

For this project, a workable instantiation:
- **Primary**: Internal SSD on the Mac, organized by LR Classic catalog
- **Local backup**: External HDD that auto-mirrors via Time Machine or `rsync`
- **Off-site backup**: A cloud archive (Backblaze, AWS S3 Glacier Deep Archive, or DigitalOcean Spaces — the project already uses Spaces) for the masters; sync nightly or after each session

### Checksums

For an archive, **checksum verification** is non-negotiable. Bit-rot is real on any storage medium over multi-year timescales, and you want to detect corruption before all three copies are corrupted.

- Generate **SHA-256** checksums for every master file at capture time.
- Store the checksum file (`.sha256` or `.md5sum`) alongside the masters.
- Run a **quarterly verification pass** that recomputes checksums and flags any drift.
- Tools: `shasum -a 256 *.dng > checksums.sha256` on macOS; or use a dedicated tool like [Bagger](https://github.com/LibraryOfCongress/bagger) (Library of Congress's own bag-it tool) for formal archival packaging.

### Master vs. derivative separation

- **Masters**: Original RAW files (`.dng` from Lumix Tether). **Read-only after capture.** Never edit, never overwrite. Multiple backups.
- **Working copies**: Lightroom Classic catalog + sidecar XMPs. These are the editing layer; back up the catalog file separately.
- **Derivatives**: Exported TIFFs/JPEGs for OCR pipeline, family viewer, etc. Reproducible from masters; back up but not as critical.

### Sources

- [Library of Congress Digital Preservation — Personal Archiving](https://www.loc.gov/preservation/digital/)
- [NEDCC Preservation Leaflet 6.6 — Digital Preservation](https://www.nedcc.org/free-resources/preservation-leaflets/6.-reformatting/6.6-digital-preservation)
- [3-2-1 Backup Rule (US-CERT / CISA)](https://www.cisa.gov/news-events/news/data-backup-options)

---

## QA / Acceptance Criteria

Use these criteria to decide whether a captured frame is good enough to ship to the OCR pipeline, or whether to reshoot. Adapted from [FADGI Still Image Technical Guidelines, 3rd Edition](https://www.digitizationguidelines.gov/guidelines/FADGI%20Technical%20Guidelines%20for%20Digitizing%20Cultural%20Heritage%20Materials_3rd%20Edition_05092023.pdf) — the institutional reference for cultural-heritage digitization. We're not aiming for FADGI 4-star (that requires test-target measurements with specialized tools); we're aiming for **FADGI 3-star equivalence as a self-assessment**.

### Resolution target

- **Minimum sampling at object plane**: ~400 PPI for unbound text, per FADGI guidance for documents up to 12×18". For our 14×16" pages on a 100MP G9 II at ~50–58" working distance, the resulting PPI is well above 400 — typically 600–800 PPI. You will be over-sampled, which is fine.
- **Frame-fill target**: page fills the captured frame with ~5–10% padding on the longest dimension. Margins much larger than that waste resolution; margins much smaller risk cutting off page edges in subsequent processing.

### Sharpness

- **Center sharpness**: when zoomed to 100%, individual pencil strokes should be cleanly resolved (no blur, no double-edges).
- **Corner sharpness**: corners should match center sharpness within visible inspection — if they don't, the page isn't parallel to the sensor (correct with cradle tilt + bubble level).
- **Reshoot threshold**: any motion blur, any focus error visible at 100%, any noticeable falloff at corners.

### Illumination uniformity

- **Side-to-side**: no visible hot side or shadow side. Inspect with a uniform target (a blank piece of the same paper) — exposure variation across the frame should be within ±0.3 stops.
- **Top-to-bottom**: same standard. Easel tilt can introduce vertical falloff; correct by re-aiming panels.
- **Reshoot threshold**: visible gradient across the page that changes the apparent ink density.

### Color

- **ColorChecker frame at session start**: every session, every batch. Without it, the session's RAWs are not normalizable across years.
- **Reshoot threshold**: missing ColorChecker frame; mid-session lighting change without a fresh ColorChecker.

### Reshoot vs. accept

- **Same session**: cheap to reshoot. Reshoot anything that fails the criteria above.
- **Across sessions**: re-shooting a previous session means re-deploying the rig and trying to match conditions. Possible but expensive in time. **Inspect each session's output before tearing down the rig** for that day; reshoot in the same session, not next month.

### What we are NOT trying to hit

This is explicitly **not** an institutional FADGI 4-star capture. Hitting 4-star requires:
- Calibrated test targets (Image Engineering Universal Test Target, or similar)
- Quantitative SFR/MTF measurement on each session
- Documented illumination uniformity measurement at the object plane
- Documented color delta-E against a reference target

Those are appropriate for archives that will be reproduced for publication or scholarly use. For a family archive, the criteria above (visual inspection at 100%, ColorChecker on every session, corner-to-corner sharpness, even illumination) are the practical equivalent.

---

## Scope and Honesty Disclaimer

This document describes a **home-practical setup** for a family-archive project, informed by institutional best practices but **not** an institutional best-practice copy stand. Specifically:

- **What's borrowed from FADGI/NEDCC/LoC**: 5000K continuous lighting, ColorChecker on every session, manual white balance, tripod-based capture, controlled (closed-blind) illumination, polarizing technique to suppress surface glare, master-vs-derivative file separation, checksums, 3-2-1 backups.
- **What's home-practical and not institutional**: tabletop easel + foamcore (institutional capture uses a copy stand or vacuum easel); horizontal capture (institutional often uses overhead with a copy stand); the Carl DC-210N rotary trimmer for irreversible cutting (institutional digitization rarely cuts irreplaceable originals — they capture bound, sometimes accepting some glare); a single-operator workflow without a documented QA pass.
- **What we're explicitly not aiming for**: FADGI 4-star compliance, AIC-conservator review of every page, peer-reviewed color profile, ISO-standardized illumination uniformity measurement.

The goal is a **searchable, recoverable, family-readable archive** of 60 years of handwritten material — captured once, well, with reasonable rigor, and stored with documented integrity. Not a museum-grade reproduction.

If at any point during the project you encounter material that exceeds this setup's safety envelope (brittle pages, suspect mold, iron-gall ink corrosion, content of historical significance beyond the family record), **stop and consult a paper conservator** before proceeding. The setup described here is not intended to handle special-handling cases.

---

## Acknowledgments / Review Lineage

This document went through several revision passes before reaching a verified state:

- **Initial draft (2026-04-19)**: Claude Code drafted the original equipment list based on user requirements (Panasonic G9 II + Olympus 60mm + small-space deployment).
- **2026-05-04 to 2026-05-06**: Iterative revisions through user-driven Q&A — added Compact tier, small-space floor coordinates, page-support kit, cutting-tools workflow, and ordering list.
- **2026-05-06 / 2026-05-08**: Successive availability checks at B&H caught a fabricated Daige Pro-Easel reference (no such product exists at the cited URL) and stale SKUs.
- **2026-05-08 — Codex review**: A second-pass adversarial review by Codex caught additional issues: discontinued Aputure SKUs, wrong G9 II resolution claim (was 80MP, actually 100MP), backward gloves recommendation (cotton gloves are not recommended for paper handling per NARA/LoC), wrong DC-210N capacity (36 sheets, not 10), and several overstated claims ("conservation-lab standard," "set once forever," "can't be fully corrected"). All flagged issues have been addressed in this revision.

The fact that an LLM-drafted document needed a full second-pass review **before** any equipment was ordered is the takeaway here: **don't trust an LLM-generated buying list without independent verification**. The version you're reading has been through that verification, but treat any specific SKU/price as confirmable-at-checkout, not as gospel.
