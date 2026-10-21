/* TPO Letter Hourglass MVP — shared price scale (TV-style) + zoom + virtualized columns */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const RANGE_PRESETS = {
    day: { sessions: 1, lookbackDays: 5, yahooRange: "5d", label: "Day" },
    week: { sessions: 5, lookbackDays: 14, yahooRange: "5d", label: "Week (5)" },
    month: { sessions: 22, lookbackDays: 45, yahooRange: "60d", label: "Month (~22)" },
    half: { sessions: 120, lookbackDays: 200, yahooRange: "6mo", label: "Half-year (~120)" },
  };

  const FIRST_PAINT = 64; // enough for 60d overview on first paint
  const FILL_CHUNK = 40;
  const BASE_ROW_H = 13;
  const HEAD_H = 44;
  const HEAD_H_THIN = 26;
  const AXIS_W = 56;
  const OVERSCAN_MIN = 4;
  const ZOOM_MIN = 0.02; // allow ~60 thin columns in a typical viewport
  const ZOOM_MAX = 2.5;
  const RIGHT_EDGE_PAD = 260; // blank space after newest day so latest HG is readable

  // Static GitHub Pages mode: load bundled data/profiles.json (no Flask).
  const STATIC_MODE =
    !!(typeof window !== "undefined" && window.TPO_STATIC) ||
    /[?&]static=1(?:&|$)/.test(location.search) ||
    location.protocol === "file:" ||
    /(?:^|\.)github\.io$/i.test(location.hostname) ||
    /(?:^|\.)github\.io(?::\d+)?$/i.test(String(location.host || ""));

  function staticProfilesUrl() {
    try {
      return new URL("data/profiles.json", document.baseURI || location.href).href;
    } catch (_) {
      return "data/profiles.json";
    }
  }

  async function readResponseJson(res, label) {
    const ct = (res.headers && res.headers.get("content-type")) || "";
    const text = await res.text();
    const trimmed = (text || "").replace(/^\uFEFF/, "").trimStart();
    const looksHtml =
      trimmed.startsWith("<") ||
      /^<!DOCTYPE/i.test(trimmed) ||
      /^<html/i.test(trimmed);
    const ctOk = /json/i.test(ct);
    if (looksHtml || (!ctOk && trimmed && !trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      throw new Error(
        "靜態版無 API（" +
          (label || res.url || "response") +
          " 回咗 HTML）。請用 data/profiles.json，或喺本地 Flask 跑。"
      );
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(
        "靜態版無 API／JSON 解析失敗（" +
          (label || "response") +
          "）：" +
          (e.message || e)
      );
    }
  }

  async function loadStaticProfiles() {
    const urls = [staticProfilesUrl(), "data/profiles.json", "./data/profiles.json"];
    // de-dupe
    const seen = new Set();
    const list = [];
    for (const u of urls) {
      if (!u || seen.has(u)) continue;
      seen.add(u);
      list.push(u);
    }
    let lastErr = null;
    for (const url of list) {
      try {
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
        return await readResponseJson(res, url);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("static profiles.json not found");
  }

  // ---- state ----
  let sessionIds = []; // oldest → newest
  let profileById = new Map();
  let lastMeta = null;
  let renderScheduled = false;
  let fillInFlight = false;
  let lastParamsKey = "";
  let zoom = 1; // scales row height + col width
  let globalGrid = null; // { minKey, maxKey, step, nBins }
  let scrollSyncing = false;
  let lastGeo = null; // { widths, offsets, totalW, gap, axisW, rh, hh, bodyH, barMode }
  let crosshair = { sid: null, price: null, key: null, localX: 0, localY: 0, visible: false };
  let singlePinSegments = []; // { startIdx, endIdx, key, price, sid, step, extendsToPad }


  function showErr(msg) {
    const el = $("err");
    if (!msg) {
      el.classList.remove("show");
      el.textContent = "";
      return;
    }
    el.textContent = msg;
    el.classList.add("show");
  }

  function showSrcNote(msg) {
    const el = $("srcNote");
    if (!msg) {
      el.classList.remove("show");
      el.textContent = "";
      return;
    }
    el.textContent = msg;
    el.classList.add("show");
  }

  function currentRange() {
    const mode = $("rangeMode").value || "half";
    return RANGE_PRESETS[mode] || RANGE_PRESETS.half;
  }

  function wantAlign() {
    return !!($("alignPrices") && $("alignPrices").checked);
  }

  function setAlignDefaultForRange() {
    const mode = $("rangeMode").value || "half";
    // Align ON by default for week / month / half-year
    if (mode === "day") {
      // leave user choice; default still useful for single day = no-op
    } else {
      $("alignPrices").checked = true;
    }
  }

  function fmtPrice(p, step) {
    const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    return Number(p).toFixed(decimals);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Per-day width from max TPO letter string length; zoom scales ch + padding.
  const CHAR_W0 = 7.2; // monospace px at zoom=1 (~11px font)
  const COL_PAD0 = 10; // left+right padding inside column at zoom=1
  const COL_MIN_PRINTS = 2; // empty / placeholder floor
  const PLACEHOLDER_PRINTS = 6;

  function maxPrintsOf(profile) {
    if (!profile || !profile.rows || !profile.rows.length) return COL_MIN_PRINTS;
    let m = 0;
    for (let i = 0; i < profile.rows.length; i++) {
      const n = (profile.rows[i].letters && profile.rows[i].letters.length) || profile.rows[i].count || 0;
      if (n > m) m = n;
    }
    // also consider POC row
    if (profile.poc && profile.poc.count && profile.poc.count > m) m = profile.poc.count;
    return Math.max(COL_MIN_PRINTS, m);
  }

  // Bar/overview: keep ≥1.5px per print so HG bell never collapses to a stick
  const BAR_PX_PER_PRINT = 1.5;
  const COL_MIN_BAR = 10;


  function sessionMid(profile) {
    // Session mid (H+L)/2 from profile price rows (no true close in TPO cache)
    if (!profile || !profile.rows || !profile.rows.length) {
      return profile && profile.poc ? profile.poc.price : null;
    }
    let hi = -Infinity;
    let lo = Infinity;
    for (const r of profile.rows) {
      if (r.price > hi) hi = r.price;
      if (r.price < lo) lo = r.price;
    }
    if (!isFinite(hi) || !isFinite(lo)) {
      return profile.poc ? profile.poc.price : null;
    }
    return (hi + lo) / 2;
  }

  function sessionTrendPrice(profile) {
    // Prefer mid; fall back to POC
    const mid = sessionMid(profile);
    if (mid != null) return mid;
    return profile && profile.poc ? profile.poc.price : null;
  }

  function dayColWFromPrints(prints) {
    if (isBarMode()) {
      const unit = Math.max(BAR_PX_PER_PRINT, CHAR_W0 * zoom);
      return Math.max(COL_MIN_BAR, Math.round(prints * unit + 2));
    }
    const ch = CHAR_W0 * zoom;
    const pad = Math.max(2, COL_PAD0 * Math.min(zoom, 1));
    return Math.max(4, Math.round(prints * ch + pad));
  }

  function dayColW(profile) {
    return dayColWFromPrints(maxPrintsOf(profile));
  }

  function colGap() {
    return zoom < 0.2 ? 1 : 2;
  }

  function rowH() {
    // Bar/overview: keep a visible bin strip so the bell silhouette never blanks
    if (isBarMode()) return Math.max(1.5, BASE_ROW_H * zoom);
    return Math.max(1, BASE_ROW_H * zoom);
  }

  function fontPx() {
    return Math.max(2, Math.min(13, 11 * zoom));
  }

  function headH() {
    // shrink header when zoomed out (overview)
    return zoom < 0.35 ? HEAD_H_THIN : HEAD_H;
  }

  function isBarMode() {
    // <50%: letters unreadable — keep HG silhouette via density bars
    // (zoom-only — do not call rowH/fontPx here; those call isBarMode)
    return zoom < 0.5;
  }

  function printCountOf(row) {
    if (!row) return 0;
    if (row.letters && row.letters.length) return row.letters.length;
    return row.count || 0;
  }

  // Cumulative column geometry for variable-width virtualization
  function buildColGeometry() {
    const gap = colGap();
    const widths = new Array(sessionIds.length);
    const offsets = new Array(sessionIds.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < sessionIds.length; i++) {
      const p = profileById.get(sessionIds[i]);
      const w = p ? dayColW(p) : dayColWFromPrints(PLACEHOLDER_PRINTS);
      widths[i] = w;
      offsets[i + 1] = offsets[i] + w + gap;
    }
    const contentW = offsets[sessionIds.length];
    return {
      widths,
      offsets,
      gap,
      contentW,
      rightEdgePad: RIGHT_EDGE_PAD,
      totalW: contentW + RIGHT_EDGE_PAD,
    };
  }

  function findColAtX(offsets, x) {
    // largest i with offsets[i] <= x
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    return Math.min(lo, Math.max(0, offsets.length - 2));
  }

  function overscanCols(avgW) {
    return Math.max(OVERSCAN_MIN, Math.ceil(160 / Math.max(4, avgW || 40)));
  }

  // ---- shared price grid across loaded sessions ----
  function computeGlobalGrid() {
    let minKey = Infinity;
    let maxKey = -Infinity;
    let step = parseFloat($("points").value) || 5;
    let n = 0;
    for (const p of profileById.values()) {
      if (!p || !p.rows || !p.rows.length) continue;
      step = p.step || step;
      for (const r of p.rows) {
        if (r.key < minKey) minKey = r.key;
        if (r.key > maxKey) maxKey = r.key;
      }
      n++;
    }
    if (!n || !isFinite(minKey)) {
      globalGrid = null;
      return null;
    }
    // Small padding so spikes aren't flush to edge
    const pad = 2;
    minKey -= pad;
    maxKey += pad;
    globalGrid = {
      minKey,
      maxKey,
      step,
      nBins: maxKey - minKey + 1,
    };
    return globalGrid;
  }

  function updateZoomLabel() {
    const el = $("zoomLabel");
    if (el) el.textContent = Math.round(zoom * 100) + "%";
  }

  // ---- CSV fallback ----
  function parseCSV(text) {
    const lines = text
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    if (lines.length < 2) throw new Error("CSV needs a header and at least one row.");
    const header = lines[0].split(/[,;\t]/).map((h) => h.trim().toLowerCase().replace(/['"]/g, ""));
    const findCol = (...names) => {
      for (const n of names) {
        const i = header.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };
    let iDt = findCol("datetime", "date", "time", "timestamp", "dt");
    let iHi = findCol("high", "h");
    let iLo = findCol("low", "l");
    if (iDt < 0 || iHi < 0 || iLo < 0) {
      if (header.length >= 3 && !isNaN(parseFloat(lines[1].split(/[,;\t]/)[1]))) {
        iDt = 0;
        iHi = 1;
        iLo = 2;
      } else {
        throw new Error("CSV needs columns: datetime, high, low.");
      }
    }
    const bars = [];
    for (let r = 1; r < lines.length; r++) {
      const cols = lines[r].split(/[,;\t]/).map((c) => c.trim().replace(/^["']|["']$/g, ""));
      if (cols.length < 3) continue;
      let d = new Date(cols[iDt]);
      if (isNaN(d.getTime())) d = new Date(cols[iDt].replace(" ", "T"));
      if (isNaN(d.getTime())) throw new Error("Bad datetime on row " + (r + 1));
      const high = parseFloat(cols[iHi]);
      const low = parseFloat(cols[iLo]);
      if (isNaN(high) || isNaN(low)) throw new Error("Bad high/low on row " + (r + 1));
      bars.push({ t: d.getTime(), high, low });
    }
    bars.sort((a, b) => a.t - b.t);
    return bars;
  }

  // ---- unaligned (per-day own scale) — day mode / align off ----
  function renderDayColumnHtml(result, opts) {
    const {
      rows, poc, vah, val, ibHi, ibLo, dualKeys, spikeKeys, step, sessionId, totalTpo,
      vaTop, vaBot, letterCount,
    } = result;
    const { showPrice, compact } = opts;
    const dual = new Set(dualKeys || []);
    const spike = new Set(spikeKeys || []);
    const nLetters = letterCount != null ? letterCount : 0;

    const lines = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const classes = [];
      if (r.key === poc.key) classes.push("row-poc");
      if (i >= vaTop && i <= vaBot) classes.push("row-va");
      if (dual.has(r.key)) classes.push("row-dual");
      if (spike.has(r.key) && !(i >= vaTop && i <= vaBot)) classes.push("row-spike");
      const inIb =
        ibHi != null &&
        r.price <= ibHi + step / 2 &&
        r.price >= ibLo - step / 2;
      if (inIb) classes.push("row-ib");

      let tags = "";
      if (!compact && r.key === poc.key) tags = `<span class="tag poc">POC</span>`;
      else if (compact && r.key === poc.key) tags = `<span class="tag poc">·</span>`;

      const priceHtml = showPrice
        ? `<span class="price">${fmtPrice(r.price, step)}</span>`
        : "";
      lines.push(
        `<span class="${classes.join(" ")}">${priceHtml}<span class="letters">${escapeHtml(
          r.letters
        )}</span>${tags}</span>`
      );
    }

    const head = `<div class="day-head"><b>${sessionId}</b>
      <div class="day-meta">POC ${fmtPrice(poc.price, step)} · VA ${fmtPrice(val.price, step)}–${fmtPrice(
      vah.price,
      step
    )} · ${nLetters}L / ${totalTpo}p</div>
    </div>`;
    const cls = compact ? "day-col" : "day-col single";
    return `<div class="${cls}" data-sid="${sessionId}">${head}<pre class="profile">${lines.join(
      "\n"
    )}</pre></div>`;
  }

  function placeholderCol(sid, w, bodyH) {
    const h = bodyH != null ? `height:${bodyH}px` : "min-height:120px";
    return `<div class="day-col day-placeholder" data-sid="${sid}" style="width:${w}px;${h}">
      <div class="day-head"><b>${sid}</b><div class="day-meta">…</div></div>
      <div class="day-body"></div>
    </div>`;
  }

  // ---- aligned column: absolute rows on shared bin grid (no empty DOM) ----
  function renderAlignedColumn(result, grid, w, rh, fp, hh) {
    const {
      rows, poc, vah, val, ibHi, ibLo, dualKeys, spikeKeys, step, sessionId, totalTpo,
      letterCount,
    } = result;
    const dual = new Set(dualKeys || []);
    const spike = new Set(spikeKeys || []);
    const bodyH = grid.nBins * rh;
    const nLetters = letterCount != null ? letterCount : 0;
    const vaHi = Math.max(vah.key, val.key);
    const vaLo = Math.min(vah.key, val.key);
    const thin = w < 48 || zoom < 0.4;
    const barMode = isBarMode();
    const maxPrints = Math.max(1, maxPrintsOf(result));
    // Compact date label for thin cols: MM-DD
    let label = sessionId;
    if (thin && /^\d{4}-\d{2}-\d{2}/.test(sessionId)) {
      label = sessionId.slice(5); // MM-DD
    } else if (sessionId.length > 10) {
      label = sessionId.slice(5) || sessionId;
    }

    // Full cell height in bar mode (tiny overlap hides hairline gaps between bins)
    const cellH = barMode ? Math.max(rh, 1.5) + (rh < 3 ? 0.35 : 0) : rh;
    const innerW = Math.max(4, w - (barMode ? 0 : 2));

    const cells = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.key < grid.minKey || r.key > grid.maxKey) continue;
      const top = (grid.maxKey - r.key) * rh;
      const n = printCountOf(r);
      if (barMode && n <= 0) continue;
      const classes = ["tpo-cell"];
      if (barMode) classes.push("bar-only");
      if (r.key === poc.key) classes.push("row-poc");
      if (r.key >= vaLo && r.key <= vaHi) classes.push("row-va");
      if (dual.has(r.key)) classes.push("row-dual");
      if (spike.has(r.key) && !(r.key >= vaLo && r.key <= vaHi)) classes.push("row-spike");
      if (
        ibHi != null &&
        r.price <= ibHi + step / 2 &&
        r.price >= ibLo - step / 2
      ) {
        classes.push("row-ib");
      }
      let style = `top:${top}px;height:${cellH}px;line-height:${cellH}px;font-size:${fp}px`;
      let text = "";
      if (barMode) {
        // Density bar width ∝ TPO prints → bell / hourglass silhouette (never lose shape)
        const frac = Math.max(0.12, Math.min(1, n / maxPrints));
        const barW = Math.max(3, Math.round(frac * innerW));
        style += `;width:${barW}px;min-width:3px;left:0`;
      } else {
        text = escapeHtml(r.letters || "");
        if (zoom < 0.65 && n > 0) {
          const minBlock = Math.max(2, Math.round((n / maxPrints) * innerW * 0.85));
          style += `;min-width:${minBlock}px`;
        }
      }
      const titleBits = [sessionId, fmtPrice(r.price, step) + " pts"];
      if (r.letters) titleBits.push(r.letters);
      else if (n) titleBits.push(String(n) + "p");
      cells.push(
        `<div class="${classes.join(" ")}" style="${style}" title="${escapeHtml(
          titleBits.join(" · ")
        )}">${text}</div>`
      );
    }

    const pocTop = (grid.maxKey - poc.key) * rh + rh / 2;
    const meta = thin
      ? ""
      : `<div class="day-meta">${fmtPrice(poc.price, step)} · ${nLetters}L</div>`;
    const head = `<div class="day-head" style="height:${hh}px"><b title="${sessionId}">${escapeHtml(
      label
    )}</b>${meta}</div>`;
    const thinCls = thin ? " thin" : "";
    const barCls = barMode ? " bar-mode" : "";
    return `<div class="day-col aligned${thinCls}${barCls}" data-sid="${sessionId}" data-date="${escapeHtml(sessionId)}" style="width:${w}px;min-width:0">
      ${head}
      <div class="day-body" style="height:${bodyH}px;position:relative">
        <div class="poc-line" style="top:${pocTop}px"></div>
        ${cells.join("")}
      </div>
    </div>`;
  }

  function renderPriceAxis(grid, rh, fp, hh) {
    const bodyH = grid.nBins * rh;
    const step = grid.step;
    hh = hh != null ? hh : HEAD_H;
    // Aim ~1 label per 20–28px; snap to nice round prices
    const minGapPx = rh < 4 ? 28 : 20;
    let nicePts = 50;
    if (step >= 1) {
      const candidates = [25, 50, 100, 200, 500, 1000];
      nicePts = candidates.find((n) => (n / step) * rh >= minGapPx) || 1000;
    } else {
      nicePts = step * Math.max(1, Math.ceil(minGapPx / rh));
    }
    const niceKeys = Math.max(1, Math.round(nicePts / step));

    const labels = [];
    // Walk from a nice key at or below maxKey
    let k0 = Math.floor(grid.maxKey / niceKeys) * niceKeys;
    if (k0 > grid.maxKey) k0 -= niceKeys;
    for (let k = k0; k >= grid.minKey; k -= niceKeys) {
      if (k < grid.minKey || k > grid.maxKey) continue;
      const price = k * step;
      const top = (grid.maxKey - k) * rh;
      labels.push(
        `<div class="axis-label" style="top:${top}px;height:${Math.max(
          rh,
          12
        )}px;line-height:${Math.max(rh, 12)}px;font-size:${Math.max(
          8,
          Math.min(11, fp)
        )}px">${fmtPrice(price, step)}</div>`
      );
    }

    return `<div class="price-axis" style="width:${AXIS_W}px">
      <div class="day-head axis-head" style="height:${hh}px"><b>Price</b><div class="day-meta">Pts ${step}</div></div>
      <div class="day-body axis-body" style="height:${bodyH}px;position:relative">${labels.join("")}</div>
    </div>`;
  }


  // ---- single-pin (isolated single-print) orphan highlights ----
  // Consecutive adjacent single-TPO levels (key runs of length ≥2) are NOT pins.
  function computeSinglePinSegments() {
    singlePinSegments = [];
    if (!wantAlign() || !globalGrid || !sessionIds.length) return singlePinSegments;
    const n = sessionIds.length;
    const step = globalGrid.step;
    const occupancy = new Array(n); // Set of keys with any print
    const isolated = new Array(n); // Set of isolated single-print keys

    for (let i = 0; i < n; i++) {
      const p = profileById.get(sessionIds[i]);
      const occ = new Set();
      const countByKey = new Map();
      if (p && p.rows) {
        for (let r = 0; r < p.rows.length; r++) {
          const row = p.rows[r];
          const c = printCountOf(row);
          if (c > 0) {
            occ.add(row.key);
            countByKey.set(row.key, c);
          }
        }
      }
      occupancy[i] = occ;

      const singleKeys = [];
      for (const [k, c] of countByKey) {
        if (c === 1) singleKeys.push(k);
      }
      singleKeys.sort((a, b) => a - b);
      const iso = new Set();
      let runStart = 0;
      while (runStart < singleKeys.length) {
        let runEnd = runStart;
        while (
          runEnd + 1 < singleKeys.length &&
          singleKeys[runEnd + 1] === singleKeys[runEnd] + 1
        ) {
          runEnd++;
        }
        // Only length-1 runs count as single pins
        if (runEnd === runStart) iso.add(singleKeys[runStart]);
        runStart = runEnd + 1;
      }
      isolated[i] = iso;
    }

    for (let i = 0; i < n; i++) {
      for (const key of isolated[i]) {
        let endIdx = n; // exclusive; n ⇒ extend through RIGHT_EDGE_PAD
        for (let j = i + 1; j < n; j++) {
          if (occupancy[j].has(key)) {
            endIdx = j;
            break;
          }
        }
        const rowPrice = (() => {
          const p = profileById.get(sessionIds[i]);
          if (p && p.rows) {
            for (let r = 0; r < p.rows.length; r++) {
              if (p.rows[r].key === key) return p.rows[r].price;
            }
          }
          return key * step;
        })();
        singlePinSegments.push({
          startIdx: i,
          endIdx,
          key,
          price: rowPrice,
          sid: sessionIds[i],
          step,
          extendsToPad: endIdx === n,
        });
      }
    }
    return singlePinSegments;
  }

  function renderSinglePinLayerHtml(geo, grid, rh, hh) {
    if (!singlePinSegments.length || !geo || !grid) return "";
    const { offsets, contentW, rightEdgePad } = geo;
    const edgePad = rightEdgePad != null ? rightEdgePad : RIGHT_EDGE_PAD;
    const cw = contentW != null ? contentW : offsets[sessionIds.length];
    const layerW = cw + edgePad;
    const bodyH = grid.nBins * rh;
    const layerH = hh + bodyH;
    const bars = [];
    for (let s = 0; s < singlePinSegments.length; s++) {
      const pin = singlePinSegments[s];
      if (pin.key < grid.minKey || pin.key > grid.maxKey) continue;
      const left = offsets[pin.startIdx];
      const right =
        pin.endIdx < sessionIds.length ? offsets[pin.endIdx] : cw + edgePad;
      const width = Math.max(1, right - left);
      const top = hh + (grid.maxKey - pin.key) * rh;
      const h = Math.max(1, rh);
      const ptsLabel = fmtPrice(pin.price, pin.step) + " pts";
      const title = ptsLabel + " · leftover " + pin.sid;
      bars.push(
        `<div class="single-pin-bar" style="left:${left}px;top:${top}px;width:${width}px;height:${h}px"` +
          ` data-pts="${escapeHtml(ptsLabel)}" data-date="${escapeHtml(pin.sid)}"` +
          ` data-key="${pin.key}" title="${escapeHtml(title)}"></div>`
      );
    }
    if (!bars.length) return "";
    return (
      `<div class="single-pin-layer" id="singlePinLayer" style="width:${layerW}px;height:${layerH}px">` +
      bars.join("") +
      `</div>`
    );
  }

  function hideSinglePinTip() {
    const tip = $("singlePinTip");
    if (tip) {
      tip.classList.remove("show");
      tip.setAttribute("aria-hidden", "true");
    }
  }

  function showSinglePinTip(bar, clientX, clientY) {
    const tip = $("singlePinTip");
    const wrap = $("hgWrap");
    if (!tip || !wrap || !bar) return;
    const pts = bar.getAttribute("data-pts") || "—";
    const date = bar.getAttribute("data-date") || "—";
    tip.innerHTML =
      `<span class="sp-pts">${escapeHtml(pts)}</span>` +
      `<span class="sp-sep">·</span>` +
      `<span class="sp-date">leftover ${escapeHtml(date)}</span>`;
    tip.classList.add("show");
    tip.setAttribute("aria-hidden", "false");
    const rect = wrap.getBoundingClientRect();
    let x = clientX - rect.left + 12;
    let y = clientY - rect.top + 12;
    const maxX = rect.width - 200;
    const maxY = rect.height - 36;
    if (x > maxX) x = clientX - rect.left - 200;
    if (y > maxY) y = clientY - rect.top - 36;
    tip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      virtualRender();
    });
  }

  function virtualRender() {
    const sc = $("profilesScroll");
    if (!sessionIds.length) {
      sc.innerHTML = `<div class="profiles-row" id="profilesRow"><div class="day-col single"><pre class="profile">No sessions.</pre></div></div>`;
      $("stats").innerHTML = "";
      return;
    }

    const align = wantAlign() && sessionIds.length > 0;
    const tRender0 = performance.now();

    if (align) {
      computeGlobalGrid();
      if (!globalGrid) {
        // Nothing loaded yet — placeholders
        virtualRenderUnaligned();
        return;
      }
      virtualRenderAligned(tRender0);
    } else {
      globalGrid = null;
      virtualRenderUnaligned();
    }
  }

  function virtualRenderUnaligned() {
    const sc = $("profilesScroll");
    if (!sc.querySelector("#profilesRow") || sc.querySelector(".profiles-aligned")) {
      sc.innerHTML = '<div class="profiles-row" id="profilesRow"></div>';
    }
    const row = $("profilesRow");
    const compact = sessionIds.length > 1;
    const geo = buildColGeometry();
    // unaligned HTML columns need a bit more room for price gutter when shown
    const widths = geo.widths.map((w) => Math.max(w, compact ? 80 : 180));
    const gap = 6;
    const offsets = [0];
    for (let i = 0; i < widths.length; i++) offsets.push(offsets[i] + widths[i] + gap);
    const totalW = offsets[offsets.length - 1];
    const scrollLeft = sc.scrollLeft;
    const viewW = sc.clientWidth || 800;
    const avgW = sessionIds.length ? totalW / sessionIds.length : 100;
    const os = overscanCols(avgW);

    let first = findColAtX(offsets, scrollLeft) - os;
    let last = findColAtX(offsets, scrollLeft + viewW) + os;
    first = Math.max(0, first);
    last = Math.min(sessionIds.length - 1, last);

    let priceIdx = -1;
    for (let i = first; i <= last; i++) {
      if (profileById.has(sessionIds[i])) {
        priceIdx = i;
        break;
      }
    }

    const parts = [];
    const leftPad = offsets[first];
    if (leftPad > 0) {
      parts.push(`<div class="virt-spacer" style="flex:0 0 ${leftPad}px;width:${leftPad}px;height:1px"></div>`);
    }
    for (let i = first; i <= last; i++) {
      const sid = sessionIds[i];
      const p = profileById.get(sid);
      if (p) {
        parts.push(renderDayColumnHtml(p, { showPrice: !compact || i === priceIdx, compact }));
      } else {
        parts.push(placeholderCol(sid, widths[i]));
      }
    }
    const contentW = offsets[offsets.length - 1];
    const virtRight = Math.max(0, contentW - offsets[last + 1]);
    const edgePad = RIGHT_EDGE_PAD;
    const rightPad = virtRight + edgePad;
    if (rightPad > 0) {
      parts.push(`<div class="virt-spacer" style="flex:0 0 ${rightPad}px;width:${rightPad}px;height:1px"></div>`);
    }

    const keep = sc.scrollLeft;
    const keepTop = sc.scrollTop;
    row.className = "profiles-row";
    row.innerHTML = parts.join("");
    sc.scrollLeft = keep;
    sc.scrollTop = keepTop;
    lastGeo = {
      align: false,
      widths,
      offsets,
      totalW: contentW + edgePad,
      contentW,
      rightEdgePad: edgePad,
      axisW: 0,
      gap,
    };
    updateTimeline();
    updateTrendChart();
    hideCrosshair();
    hideSinglePinTip();
    singlePinSegments = [];
    updateStats(null);
  }

  function virtualRenderAligned(tRender0) {
    const sc = $("profilesScroll");
    const grid = globalGrid;
    const rh = rowH();
    const fp = fontPx();
    const hh = headH();
    const bodyH = grid.nBins * rh;
    const geo = buildColGeometry();
    const { widths, offsets, totalW } = geo;

    const scrollLeft = sc.scrollLeft;
    const viewW = sc.clientWidth || 800;
    const avgW = sessionIds.length ? totalW / sessionIds.length : 40;
    const os = overscanCols(avgW);

    let first = findColAtX(offsets, scrollLeft) - os;
    let last = findColAtX(offsets, scrollLeft + viewW) + os;
    first = Math.max(0, first);
    last = Math.min(sessionIds.length - 1, last);

    // Cap DOM columns so extreme zoom-out still stays snappy
    const MAX_DOM = 90;
    if (last - first + 1 > MAX_DOM) {
      const mid = Math.floor((first + last) / 2);
      first = Math.max(0, mid - Math.floor(MAX_DOM / 2));
      last = Math.min(sessionIds.length - 1, first + MAX_DOM - 1);
    }

    const parts = [];
    const leftPad = offsets[first];
    const spacerH = hh + bodyH;
    if (leftPad > 0) {
      parts.push(
        `<div class="virt-spacer" style="flex:0 0 ${leftPad}px;width:${leftPad}px;height:${spacerH}px"></div>`
      );
    }

    for (let i = first; i <= last; i++) {
      const sid = sessionIds[i];
      const p = profileById.get(sid);
      const w = widths[i];
      if (p) {
        parts.push(renderAlignedColumn(p, grid, w, rh, fp, hh));
      } else {
        parts.push(placeholderCol(sid, w, spacerH));
      }
    }

    const contentW = geo.contentW != null ? geo.contentW : offsets[sessionIds.length];
    const virtRight = Math.max(0, contentW - offsets[last + 1]);
    const edgePad = geo.rightEdgePad != null ? geo.rightEdgePad : RIGHT_EDGE_PAD;
    const rightPad = virtRight + edgePad;
    if (rightPad > 0) {
      parts.push(
        `<div class="virt-spacer" style="flex:0 0 ${rightPad}px;width:${rightPad}px;height:${spacerH}px"></div>`
      );
    }

    const keep = sc.scrollLeft;
    const keepTop = sc.scrollTop;

    computeSinglePinSegments();
    const pinLayer = renderSinglePinLayerHtml(
      { offsets, contentW, rightEdgePad: edgePad },
      grid,
      rh,
      hh
    );
    const axisHtml = renderPriceAxis(grid, rh, fp, hh);
    sc.innerHTML =
      `<div class="profiles-aligned">` +
      axisHtml +
      `<div class="profiles-row" id="profilesRow" style="gap:${geo.gap}px;position:relative">` +
      pinLayer +
      `${parts.join("")}</div>` +
      `</div>`;

    sc.scrollLeft = keep;
    sc.scrollTop = keepTop;

    lastGeo = {
      widths,
      offsets,
      totalW: contentW + edgePad,
      contentW,
      rightEdgePad: edgePad,
      gap: geo.gap,
      axisW: AXIS_W,
      rh,
      hh,
      bodyH,
      barMode: isBarMode(),
      align: true,
    };
    updateTimeline();
    updateTrendChart();
    if (crosshair.visible) refreshCrosshairHud();

    const ms = Math.round(performance.now() - (tRender0 || performance.now()));
    updateStats(ms);
  }

  function updateStats(renderMs) {
    const loaded = profileById.size;
    const firstId = sessionIds[0] || "—";
    const lastId = sessionIds[sessionIds.length - 1] || "—";
    const lastP = profileById.get(lastId);
    const step = lastP ? lastP.step : parseFloat($("points").value) || 5;
    const g = globalGrid;
    $("stats").innerHTML = [
      `<span><b>Days</b>${sessionIds.length}</span>`,
      `<span><b>Loaded</b>${loaded}/${sessionIds.length}</span>`,
      `<span><b>From</b>${firstId}</span>`,
      `<span><b>To</b>${lastId}</span>`,
      wantAlign() && g
        ? `<span><b>Scale</b>${fmtPrice(g.minKey * g.step, step)}–${fmtPrice(
            g.maxKey * g.step,
            step
          )} (${g.nBins} bins)</span>`
        : `<span><b>Align</b>off</span>`,
      `<span><b>Zoom</b>${Math.round(zoom * 100)}%</span>`,
      lastP ? `<span><b>Latest POC</b>${fmtPrice(lastP.poc.price, step)}</span>` : "",
      `<span><b>Points</b>${step}</span>`,
      renderMs != null ? `<span><b>Render</b>${renderMs}ms</span>` : "",
      lastMeta && lastMeta.timingMs
        ? `<span><b>API</b>${lastMeta.timingMs.total}ms</span>`
        : "",
    ]
      .filter(Boolean)
      .join("");
    updateZoomLabel();
  }

  function scrollToNewest() {
    requestAnimationFrame(() => {
      const sc = $("profilesScroll");
      // In aligned mode content is wider; scroll to right
      sc.scrollLeft = sc.scrollWidth;
      scheduleRender();
    });
  }

  // ---- zoom ----
  function setZoom(z, opts) {
    opts = opts || {};
    const sc = $("profilesScroll");
    const prevZoom = zoom;
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

    // Keep vertical center price stable when zooming
    if (sc && globalGrid && prevZoom > 0 && !opts.skipAnchor) {
      const rh0 = Math.max(2, BASE_ROW_H * prevZoom);
      const centerY = sc.scrollTop + sc.clientHeight / 2 - HEAD_H;
      const keyAtCenter = globalGrid.maxKey - centerY / rh0;
      scheduleRender();
      requestAnimationFrame(() => {
        const rh1 = rowH();
        const newTop = (globalGrid.maxKey - keyAtCenter) * rh1 - sc.clientHeight / 2 + HEAD_H;
        sc.scrollTop = Math.max(0, newTop);
        scheduleRender();
      });
      updateZoomLabel();
      return;
    }
    updateZoomLabel();
    scheduleRender();
  }

  function zoomBy(factor) {
    setZoom(zoom * factor);
  }

  // Natural (zoom=1) total width of a slice of days, from max TPO prints
  function naturalWidthForRange(fromIdx, toIdx) {
    const gap1 = 2;
    let sum = 0;
    for (let i = fromIdx; i <= toIdx; i++) {
      const p = profileById.get(sessionIds[i]);
      const prints = p ? maxPrintsOf(p) : PLACEHOLDER_PRINTS;
      sum += prints * CHAR_W0 + COL_PAD0 + gap1;
    }
    return Math.max(1, sum);
  }

  function zoomFitAll() {
    if (!wantAlign()) {
      $("alignPrices").checked = true;
    }
    computeGlobalGrid();
    const sc = $("profilesScroll");
    if (!sc || !sessionIds.length) {
      scheduleRender();
      return;
    }
    const viewH = Math.max(120, sc.clientHeight - HEAD_H - 8);
    const viewW = Math.max(160, sc.clientWidth - AXIS_W - 8 - RIGHT_EDGE_PAD);
    const natW = naturalWidthForRange(0, sessionIds.length - 1);
    const zoomX = viewW / natW;
    const zoomY = globalGrid
      ? viewH / (globalGrid.nBins * BASE_ROW_H)
      : 1;
    // Fit both axes so all days + full price range are on screen
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(zoomX, zoomY)));
    zoom = z;
    updateZoomLabel();
    scheduleRender();
    requestAnimationFrame(() => {
      sc.scrollTop = 0;
      sc.scrollLeft = 0;
      scheduleRender();
    });
  }

  function sliceWidthAtZoom(z, fromIdx, toIdx) {
    const prev = zoom;
    zoom = z;
    let sum = 0;
    const gap = colGap();
    for (let i = fromIdx; i <= toIdx; i++) {
      const p = profileById.get(sessionIds[i]);
      sum += (p ? dayColW(p) : dayColWFromPrints(PLACEHOLDER_PRINTS)) + gap;
    }
    zoom = prev;
    return sum;
  }

  // Fit ~nDays columns; bar-mode floor keeps HG silhouette readable (may need H-scroll)
  function zoomFitDays(nDays) {
    if (!wantAlign()) {
      $("alignPrices").checked = true;
    }
    computeGlobalGrid();
    const sc = $("profilesScroll");
    if (!sc || !sessionIds.length) {
      scheduleRender();
      return;
    }
    const n = Math.min(Math.max(1, nDays), sessionIds.length);
    const toIdx = sessionIds.length - 1;
    const fromIdx = toIdx - n + 1;
    // Reserve right-edge breathing room so newest columns aren't flush
    const viewW = Math.max(160, sc.clientWidth - AXIS_W - 8 - RIGHT_EDGE_PAD);

    // Binary search largest zoom whose real (bar-aware) width still fits
    let lo = ZOOM_MIN;
    let hi = Math.min(ZOOM_MAX, 1.2);
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (sliceWidthAtZoom(mid, fromIdx, toIdx) <= viewW) lo = mid;
      else hi = mid;
    }
    // Prefer fitting; if even ZOOM_MIN (with bar floors) is wider, stay at min — silhouette > crush
    zoom = lo;
    updateZoomLabel();
    scheduleRender();
    requestAnimationFrame(() => {
      sc.scrollLeft = Math.max(0, sc.scrollWidth - sc.clientWidth);
      if (globalGrid) {
        const rh = rowH();
        const hh = headH();
        const midKey = (globalGrid.minKey + globalGrid.maxKey) / 2;
        const top = (globalGrid.maxKey - midKey) * rh - sc.clientHeight / 2 + hh;
        sc.scrollTop = Math.max(0, top);
      }
      scheduleRender();
    });
  }

  function zoomReset() {
    setZoom(1, { skipAnchor: true });
  }

  function qsParams(extra) {
    const preset = currentRange();
    const qs = new URLSearchParams({
      source: $("source").value,
      symbol: ($("symbol").value || "HSIF").trim(),
      interval: "5m",
      range: preset.yahooRange,
      lookback_days: String(preset.lookbackDays),
      sessions: String(preset.sessions),
      points: $("points").value,
      block_min: $("blockMin").value,
      open: $("sessOpen").value,
      close: $("sessClose").value,
      tz: $("tz").value,
      alphabet: $("alphabet").value,
      first_letter: $("firstLetter").value,
      va_pct: $("vaPct").value,
      tail: "1",
    });
    const date = ($("sessDate").value || "").trim();
    if (date) qs.set("date", date);
    if (extra) {
      for (const [k, v] of Object.entries(extra)) qs.set(k, String(v));
    }
    return qs;
  }

  function ingestProfiles(payload) {
    if (payload.sessionIds && payload.sessionIds.length) {
      sessionIds = payload.sessionIds.slice();
    }
    for (const p of payload.profiles || []) {
      profileById.set(p.sessionId, p);
    }
    lastMeta = payload;
    if (wantAlign()) computeGlobalGrid();
  }

  async function fillOlder() {
    if (STATIC_MODE) return;
    if (fillInFlight) return;
    const total = sessionIds.length;
    const loaded = profileById.size;
    if (loaded >= total) return;
    fillInFlight = true;
    try {
      let suffix = 0;
      for (let i = sessionIds.length - 1; i >= 0; i--) {
        if (profileById.has(sessionIds[i])) suffix++;
        else break;
      }
      const qs = qsParams({
        limit: FILL_CHUNK,
        offset: suffix,
        tail: "1",
      });
      const t0 = performance.now();
      if (STATIC_MODE) return;
      const res = await fetch("/api/profiles?" + qs.toString());
      const payload = await readResponseJson(res, "/api/profiles");
      if (!res.ok || payload.error) throw new Error(payload.error || "HTTP " + res.status);
      ingestProfiles(payload);
      const ms = Math.round(performance.now() - t0);
      showSrcNote(
        [
          payload.source,
          payload.symbol,
          `${profileById.size}/${sessionIds.length} days`,
          `fill +${(payload.profiles || []).length} in ${ms}ms`,
          payload.cacheHits != null ? `cache hit ${payload.cacheHits}` : "",
          globalGrid
            ? `scale ${fmtPrice(globalGrid.minKey * globalGrid.step, globalGrid.step)}–${fmtPrice(
                globalGrid.maxKey * globalGrid.step,
                globalGrid.step
              )}`
            : "",
          payload.note,
        ]
          .filter(Boolean)
          .join(" · ")
      );
      scheduleRender();
      if (profileById.size < sessionIds.length) {
        setTimeout(() => {
          fillInFlight = false;
          fillOlder();
        }, 16);
        return;
      }
    } catch (e) {
      console.error(e);
      showErr("Background fill: " + (e.message || e));
    } finally {
      fillInFlight = false;
    }
  }

  async function fetchAndBuild(opts) {
    opts = opts || {};
    showErr("");
    showSrcNote(STATIC_MODE ? "Loading static snapshot…" : "Loading…");
    const btn = $("btnFetch");
    btn.disabled = true;
    const t0 = performance.now();
    try {
      profileById = new Map();
      sessionIds = [];
      globalGrid = null;
      setAlignDefaultForRange();
      let payload;
      if (STATIC_MODE) {
        lastParamsKey = "static";
        payload = await loadStaticProfiles();
        if (!payload || payload.error) throw new Error((payload && payload.error) || "static load failed");
      } else {
      const firstLimit =
        currentRange().sessions <= FIRST_PAINT ? currentRange().sessions : FIRST_PAINT;
      const qs = qsParams({
        limit: firstLimit,
        offset: 0,
        tail: "1",
        refresh: opts.refresh ? "1" : "0",
      });
      lastParamsKey = qs.toString();
      const res = await fetch("/api/profiles?" + qs.toString());
      payload = await readResponseJson(res, "/api/profiles");
      if (!res.ok || payload.error) throw new Error(payload.error || "HTTP " + res.status);
      }

      if (payload.source === "futu" || payload.source === "tv" || (payload.symbol || "").includes("HSI")) {
        if ($("tz").value === "America/New_York") $("tz").value = "Asia/Hong_Kong";
      }

      ingestProfiles(payload);
      const ms = Math.round(performance.now() - t0);
      showSrcNote(
        [
          payload.source,
          payload.symbol,
          payload.shortName,
          `${payload.returned}/${payload.total} days first paint`,
          `${ms}ms (api ${payload.timingMs && payload.timingMs.total}ms)`,
          wantAlign() ? "aligned scale" : "per-day scale",
          payload.barsFrom,
          payload.cacheMisses ? `built ${payload.rebuilt}` : "cache warm",
          payload.note,
        ]
          .filter(Boolean)
          .join(" · ")
      );
      scheduleRender();
      // After first paint: 60d overview for long ranges, else newest
      if (wantAlign() && currentRange().sessions >= 60) {
        requestAnimationFrame(() => zoomFitDays(60));
      } else if (wantAlign() && currentRange().sessions >= 22) {
        requestAnimationFrame(() => zoomFitDays(Math.min(30, currentRange().sessions)));
      } else {
        scrollToNewest();
      }

      if (profileById.size < sessionIds.length) {
        setTimeout(fillOlder, 30);
      }
    } catch (e) {
      console.error(e);
      showErr(e.message || String(e));
    } finally {
      btn.disabled = false;
    }
  }

  function rebuildVisible() {
    if (STATIC_MODE) {
      showSrcNote("靜態版：Reload snapshot（無 Flask API）…");
      fetchAndBuild({ refresh: false });
      return;
    }
    fetchAndBuild({ refresh: false });
  }

  async function loadSample() {
    showErr("");
    try {
      const res = await fetch("sample.csv");
      if (!res.ok) throw new Error("Could not fetch sample.csv");
      $("csvText").value = await res.text();
      $("sessOpen").value = "0930";
      $("sessClose").value = "1600";
      $("tz").value = "America/New_York";
      $("points").value = "5";
      $("alphabet").value = "hk";
      $("firstLetter").value = "D";
      $("rangeMode").value = "day";
      document.querySelectorAll(".range-btn").forEach((b) => {
        b.classList.toggle("active", b.getAttribute("data-range") === "day");
      });
      showSrcNote("Sample is US-hours demo; prefer Fetch HSIF.");
      showErr("Sample CSV is fallback only. Click Fetch & build for HSIF (fast cached path).");
    } catch (e) {
      showErr(e.message || String(e));
    }
  }


  // ---- timeline + crosshair (date + price points) ----
  function hideCrosshair() {
    crosshair.visible = false;
    const ov = $("crosshairOverlay");
    if (ov) ov.classList.remove("show");
    const tl = $("tlReadout");
    if (tl) tl.innerHTML = "Date · <b>Pts</b>";
    updateTrendChart();
  }

  function updateTimeline() {
    const inner = $("timelineInner");
    const sc = $("profilesScroll");
    if (!inner || !sc) return;
    if (!lastGeo || !sessionIds.length || !lastGeo.offsets) {
      inner.innerHTML = "";
      inner.style.width = "0px";
      return;
    }
    const { widths, offsets, totalW, axisW } = lastGeo;
    const pad = 8;
    const fullW = axisW + totalW + pad;
    inner.style.width = fullW + "px";

    const ticks = [];
    let lastX = -999;
    const avgW = sessionIds.length ? totalW / sessionIds.length : 40;
    const stepN = Math.max(1, Math.ceil(42 / Math.max(8, avgW)));
    for (let i = 0; i < sessionIds.length; i += stepN) {
      const x = axisW + offsets[i];
      if (x - lastX < 36 && i !== 0) continue;
      lastX = x;
      let label = sessionIds[i];
      if (/^\d{4}-\d{2}-\d{2}/.test(label)) label = label.slice(5);
      const w = Math.max(widths[i], 24);
      ticks.push(
        `<div class="tl-tick" data-idx="${i}" style="left:${x}px;width:${w}px">${escapeHtml(label)}</div>`
      );
    }
    const last = sessionIds.length - 1;
    if (last > 0 && last % stepN !== 0) {
      const x = axisW + offsets[last];
      let label = sessionIds[last];
      if (/^\d{4}-\d{2}-\d{2}/.test(label)) label = label.slice(5);
      ticks.push(
        `<div class="tl-tick" data-idx="${last}" style="left:${x}px;width:${Math.max(widths[last], 24)}px">${escapeHtml(label)}</div>`
      );
    }
    inner.innerHTML = ticks.join("");
    syncTimelineScroll();
  }

  function syncTimelineScroll() {
    const inner = $("timelineInner");
    const sc = $("profilesScroll");
    if (!inner || !sc) return;
    inner.style.transform = `translateX(${-sc.scrollLeft}px)`;
  }

  function updateTrendChart() {
    const canvas = $("trendCanvas");
    const sc = $("profilesScroll");
    const badge = document.querySelector(".trend-badge");
    if (!canvas || !sc) return;
    if (!lastGeo || !sessionIds.length) {
      const ctx0 = canvas.getContext("2d");
      if (ctx0) {
        canvas.width = canvas.clientWidth || 1;
        canvas.height = canvas.clientHeight || 1;
        ctx0.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, canvas.clientWidth || sc.clientWidth || 800);
    const cssH = Math.max(1, canvas.clientHeight || 84);
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const axisW = lastGeo.align ? (lastGeo.axisW || 0) : 0;
    const { widths, offsets, contentW } = lastGeo;
    const cw = contentW != null ? contentW : lastGeo.totalW - (lastGeo.rightEdgePad || 0);
    if (!widths || !offsets) return;

    // Collect mid prices
    const pts = [];
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let i = 0; i < sessionIds.length; i++) {
      const p = profileById.get(sessionIds[i]);
      const price = p ? sessionTrendPrice(p) : null;
      if (price == null) continue;
      const xCenter = axisW + offsets[i] + widths[i] / 2 - sc.scrollLeft;
      pts.push({ i, sid: sessionIds[i], price, xCenter, w: widths[i] });
      if (price < yMin) yMin = price;
      if (price > yMax) yMax = price;
    }
    if (!pts.length || !isFinite(yMin)) return;

    const padY = Math.max((yMax - yMin) * 0.12, (lastGeo.align && globalGrid ? globalGrid.step : 5) * 2);
    yMin -= padY;
    yMax += padY;
    if (yMax <= yMin) {
      yMin -= 10;
      yMax += 10;
    }

    const plotL = axisW;
    const plotR = cssW;
    const plotT = 16;
    const plotB = cssH - 6;
    const plotH = Math.max(1, plotB - plotT);

    function yOf(price) {
      return plotT + ((yMax - price) / (yMax - yMin)) * plotH;
    }

    // axis gutter
    if (axisW > 0) {
      ctx.fillStyle = "#0a0e14";
      ctx.fillRect(0, 0, axisW, cssH);
      ctx.strokeStyle = "#2d3a4f";
      ctx.beginPath();
      ctx.moveTo(axisW + 0.5, 0);
      ctx.lineTo(axisW + 0.5, cssH);
      ctx.stroke();
      const step = globalGrid ? globalGrid.step : 5;
      ctx.fillStyle = "#8b9bb4";
      ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(fmtPrice(yMax, step), axisW - 4, plotT + 4);
      ctx.fillText(fmtPrice(yMin, step), axisW - 4, plotB - 4);
      const midP = (yMin + yMax) / 2;
      ctx.fillText(fmtPrice(midP, step), axisW - 4, yOf(midP));
    }

    // clip to plot area
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotL, 0, plotR - plotL, cssH);
    ctx.clip();

    // grid
    ctx.strokeStyle = "#1a2332";
    ctx.lineWidth = 1;
    for (let g = 0; g < 3; g++) {
      const yy = plotT + (plotH * g) / 2;
      ctx.beginPath();
      ctx.moveTo(plotL, yy);
      ctx.lineTo(plotR, yy);
      ctx.stroke();
    }

    // line + fill
    const visible = pts.filter((p) => p.xCenter >= plotL - 40 && p.xCenter <= plotR + 40);
    if (visible.length) {
      ctx.beginPath();
      ctx.moveTo(visible[0].xCenter, yOf(visible[0].price));
      for (let k = 1; k < visible.length; k++) {
        ctx.lineTo(visible[k].xCenter, yOf(visible[k].price));
      }
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 1.75;
      ctx.lineJoin = "round";
      ctx.stroke();

      // soft fill
      ctx.lineTo(visible[visible.length - 1].xCenter, plotB);
      ctx.lineTo(visible[0].xCenter, plotB);
      ctx.closePath();
      ctx.fillStyle = "#38bdf822";
      ctx.fill();

      // dots when columns are wide enough
      const avgW = sessionIds.length ? cw / sessionIds.length : 20;
      if (avgW >= 10) {
        for (const p of visible) {
          ctx.beginPath();
          ctx.arc(p.xCenter, yOf(p.price), avgW >= 28 ? 2.5 : 1.5, 0, Math.PI * 2);
          ctx.fillStyle = "#7dd3fc";
          ctx.fill();
        }
      }
    }

    // crosshair day marker
    if (crosshair.visible && crosshair.colIdx != null && crosshair.colIdx >= 0) {
      const i = crosshair.colIdx;
      if (i < sessionIds.length) {
        const x = axisW + offsets[i] + widths[i] / 2 - sc.scrollLeft;
        const p = profileById.get(sessionIds[i]);
        const price = p ? sessionTrendPrice(p) : null;
        ctx.strokeStyle = "#93c5fd99";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, cssH);
        ctx.stroke();
        if (price != null) {
          const yy = yOf(price);
          ctx.beginPath();
          ctx.arc(x, yy, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = "#fbbf24";
          ctx.fill();
          ctx.strokeStyle = "#0a0e14";
          ctx.stroke();
        }
      }
    }

    ctx.restore();

    if (badge && pts.length) {
      const last = pts[pts.length - 1];
      const step = globalGrid ? globalGrid.step : 5;
      badge.innerHTML =
        `Trend · <b>mid</b> (H+L)/2 · last ${escapeHtml(fmtPrice(last.price, step))}`;
    }
  }



  function hitTestChart(clientX, clientY) {
    const sc = $("profilesScroll");
    if (!sc || !lastGeo || !lastGeo.align || !globalGrid) return null;
    const rect = sc.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    if (localX < 0 || localY < 0 || localX > rect.width || localY > rect.height) return null;

    const style = getComputedStyle(sc);
    const padL = parseFloat(style.paddingLeft) || 0;
    const padT = parseFloat(style.paddingTop) || 0;
    const xContent = localX + sc.scrollLeft - padL;
    const yContent = localY + sc.scrollTop - padT;

    const axisW = lastGeo.axisW || 0;
    const xInRow = xContent - axisW;
    let colIdx = 0;
    let sid = null;
    if (xInRow >= 0 && lastGeo.offsets) {
      colIdx = findColAtX(lastGeo.offsets, xInRow);
      colIdx = Math.max(0, Math.min(sessionIds.length - 1, colIdx));
      sid = sessionIds[colIdx];
    }

    const yInBody = yContent - lastGeo.hh;
    const key = Math.round(globalGrid.maxKey - yInBody / Math.max(0.01, lastGeo.rh));
    const clampedKey = Math.max(globalGrid.minKey, Math.min(globalGrid.maxKey, key));
    const price = clampedKey * globalGrid.step;

    return {
      localX,
      localY,
      colIdx,
      sid,
      key: clampedKey,
      price,
      step: globalGrid.step,
    };
  }

  function refreshCrosshairHud() {
    if (!crosshair.visible) return;
    const ov = $("crosshairOverlay");
    const hud = $("chHud");
    const v = $("chV");
    const h = $("chH");
    const tl = $("tlReadout");
    if (!ov || !hud || !v || !h) return;
    ov.classList.add("show");
    v.style.left = crosshair.localX + "px";
    h.style.top = crosshair.localY + "px";

    const dateStr = crosshair.sid || "—";
    const ptsStr = crosshair.price != null
      ? fmtPrice(crosshair.price, crosshair.step || 5) + " pts"
      : "—";
    hud.innerHTML =
      `<span class="ch-date">${escapeHtml(dateStr)}</span>` +
      `<span class="ch-sep">·</span>` +
      `<span class="ch-pts">${escapeHtml(ptsStr)}</span>`;

    const sc = $("profilesScroll");
    const maxX = (sc && sc.clientWidth) || 400;
    const maxY = (sc && sc.clientHeight) || 300;
    let hx = crosshair.localX + 12;
    let hy = crosshair.localY + 12;
    if (hx > maxX - 160) hx = crosshair.localX - 160;
    if (hy > maxY - 40) hy = crosshair.localY - 36;
    hud.style.transform = `translate(${Math.max(4, hx)}px, ${Math.max(4, hy)}px)`;

    if (tl) {
      tl.innerHTML = `${escapeHtml(dateStr)} · <b>${escapeHtml(ptsStr)}</b>`;
    }

    document.querySelectorAll(".tl-tick.active").forEach((el) => el.classList.remove("active"));
    if (crosshair.colIdx != null) {
      const tick = document.querySelector(`.tl-tick[data-idx="${crosshair.colIdx}"]`);
      if (tick) tick.classList.add("active");
    }
    updateTrendChart();
  }

  function onChartPointer(ev) {
    const hit = hitTestChart(ev.clientX, ev.clientY);
    if (!hit || !hit.sid) {
      hideCrosshair();
      return;
    }
    crosshair.visible = true;
    crosshair.sid = hit.sid;
    crosshair.price = hit.price;
    crosshair.key = hit.key;
    crosshair.step = hit.step;
    crosshair.colIdx = hit.colIdx;
    crosshair.localX = hit.localX;
    crosshair.localY = hit.localY;
    refreshCrosshairHud();
  }

  // Range toggle
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-range");
      $("rangeMode").value = mode;
      document.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      setAlignDefaultForRange();
      fetchAndBuild();
    });
  });

  $("btnFetch").addEventListener("click", () => fetchAndBuild({ refresh: true }));
  $("btnBuild").addEventListener("click", rebuildVisible);
  $("btnSample").addEventListener("click", loadSample);
  $("btnFile").addEventListener("click", () => $("fileInput").click());

  $("alignPrices").addEventListener("change", () => {
    scheduleRender();
    if (wantAlign() && profileById.size) {
      computeGlobalGrid();
      scheduleRender();
    }
  });

  $("btnZoomIn").addEventListener("click", () => zoomBy(1.25));
  $("btnZoomOut").addEventListener("click", () => zoomBy(1 / 1.25));
  $("btnZoomFit").addEventListener("click", () => zoomFitAll());
  $("btnZoom100").addEventListener("click", () => zoomReset());
  const btn30 = $("btnView30");
  const btn60 = $("btnView60");
  if (btn30) btn30.addEventListener("click", () => zoomFitDays(30));
  if (btn60) btn60.addEventListener("click", () => zoomFitDays(60));

  // Ctrl/Cmd + wheel zoom
  $("profilesScroll").addEventListener(
    "wheel",
    (ev) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      setZoom(zoom * factor);
    },
    { passive: false }
  );

  $("fileInput").addEventListener("change", async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      $("csvText").value = text;
      const bars = parseCSV(text);
      const symbol = ($("symbol").value || "UPLOAD").trim();
      if (STATIC_MODE) {
        throw new Error("靜態版無 API：GitHub Pages 唔支援 Upload/ingest，請用本地 Flask。");
      }
      const res = await fetch("/api/ingest/tv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: symbol.startsWith("HK") || symbol.includes(":") ? symbol : "UPLOAD:" + symbol,
          bars: bars.map((b) => ({ t: b.t, h: b.high, l: b.low })),
          interval: "5m",
          timezone: $("tz").value,
        }),
      });
      const payload = await readResponseJson(res, "/api/ingest/tv");
      if (!res.ok || payload.error) throw new Error(payload.error || "ingest failed");
      $("source").value = "tv";
      $("symbol").value = symbol.startsWith("HK") || symbol.includes(":") ? symbol : "UPLOAD:" + symbol;
      showSrcNote("Ingested " + payload.barCount + " bars → building…");
      await fetchAndBuild({ refresh: true });
    } catch (e) {
      showErr(e.message || String(e));
    }
  });

  document.querySelectorAll(".chip[data-sym]").forEach((el) => {
    el.addEventListener("click", () => {
      $("symbol").value = el.getAttribute("data-sym");
      const src = el.getAttribute("data-src");
      if (src) $("source").value = src;
    });
  });

  $("profilesScroll").addEventListener(
    "scroll",
    () => {
      scheduleRender();
      syncTimelineScroll();
      updateTrendChart();
    },
    { passive: true }
  );

  const scEl = $("profilesScroll");
  if (scEl) {
    scEl.addEventListener("mousemove", onChartPointer, { passive: true });
    scEl.addEventListener("mouseleave", () => {
      hideCrosshair();
      hideSinglePinTip();
    }, { passive: true });
    scEl.addEventListener(
      "mouseover",
      (ev) => {
        const bar = ev.target && ev.target.closest && ev.target.closest(".single-pin-bar");
        if (bar) showSinglePinTip(bar, ev.clientX, ev.clientY);
      },
      { passive: true }
    );
    scEl.addEventListener(
      "mousemove",
      (ev) => {
        const bar = ev.target && ev.target.closest && ev.target.closest(".single-pin-bar");
        if (bar) showSinglePinTip(bar, ev.clientX, ev.clientY);
        else hideSinglePinTip();
      },
      { passive: true }
    );
  }

  // Redraw trend on pane resize
  if (typeof ResizeObserver !== "undefined") {
    const tp = $("trendPane");
    if (tp) {
      const ro = new ResizeObserver(() => updateTrendChart());
      ro.observe(tp);
    }
  }
  window.addEventListener("resize", () => updateTrendChart(), { passive: true });


  // —— Settings pane collapse (mobile priority; FAB stays reachable) ——
  const SETTINGS_COLLAPSE_KEY = "tpo-settings-collapsed";
  const layoutEl = document.getElementById("appLayout") || document.querySelector(".layout");
  const btnCollapseSettings = $("btnCollapseSettings");
  const btnExpandSettings = $("btnExpandSettings");

  function isNarrowViewport() {
    return window.matchMedia("(max-width: 900px)").matches;
  }

  function setSettingsCollapsed(collapsed, { persist = true } = {}) {
    if (!layoutEl) return;
    layoutEl.classList.toggle("settings-collapsed", !!collapsed);
    if (btnCollapseSettings) {
      // Header control only meaningful while expanded (aside visible)
      btnCollapseSettings.setAttribute("aria-expanded", collapsed ? "false" : "true");
      btnCollapseSettings.textContent = "收起";
      btnCollapseSettings.title = "收起設定";
      btnCollapseSettings.hidden = !!collapsed;
    }
    if (btnExpandSettings) {
      // Always show FAB: 「設定」when collapsed, 「收起」when expanded (mobile thumb reach)
      btnExpandSettings.classList.add("show");
      btnExpandSettings.classList.toggle("is-collapse", !collapsed);
      btnExpandSettings.textContent = collapsed ? "設定" : "收起";
      btnExpandSettings.setAttribute("aria-label", collapsed ? "展開設定" : "收起設定");
      btnExpandSettings.title = collapsed ? "展開設定" : "收起設定";
      btnExpandSettings.setAttribute("aria-hidden", "false");
    }
    if (persist) {
      try {
        localStorage.setItem(SETTINGS_COLLAPSE_KEY, collapsed ? "1" : "0");
      } catch (_) {}
    }
    // Chart fills freed space
    requestAnimationFrame(() => {
      try {
        scheduleRender();
      } catch (_) {}
      try {
        updateTrendChart();
      } catch (_) {}
      window.dispatchEvent(new Event("resize"));
    });
  }

  function readStoredCollapsed() {
    try {
      const v = localStorage.getItem(SETTINGS_COLLAPSE_KEY);
      if (v === "1") return true;
      if (v === "0") return false;
    } catch (_) {}
    // First visit: collapse on phone so HG gets the screen
    return isNarrowViewport();
  }

  if (btnCollapseSettings) {
    btnCollapseSettings.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setSettingsCollapsed(true);
    });
  }
  if (btnExpandSettings) {
    btnExpandSettings.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const now = layoutEl && layoutEl.classList.contains("settings-collapsed");
      setSettingsCollapsed(!now);
    });
  }


  // ---- Legend info tips (POC / VA / Dual / Spike / IB / Single pin) ----
  const LEGEND_TIPS = {
    poc: {
      name: "POC",
      body: "全日 TPO 最多嘅價位；同分揀離 mid 最近。",
    },
    va: {
      name: "VA / VAH / VAL",
      body: "由 POC 向外擴，累積約 70% TPO → 價值區上下沿。",
    },
    ib: {
      name: "IB",
      body: "首兩格 TPO（Initial Balance）高低。",
    },
    dual: {
      name: "Dual",
      body: "VA 外次高峰：count≥max(2,最高×0.7)，同 POC 之間有谷（中間最少＜該行×0.6 且＜最高×0.5）。淺藍。",
    },
    spike: {
      name: "Spike",
      body: "VA 外薄尾，該行 count≤2。紅。",
    },
    singlepin: {
      name: "Single pin",
      body: "孤立單格（連續單格唔算）淡紫向右伸到撞 TPO；hover 條帶另有點數+遺留日。",
    },
  };

  const legendTipEl = $("legendTip");
  let legendTipOpenItem = null;
  let legendLongPressTimer = null;
  let legendTipPinned = false;

  function hideLegendTip() {
    if (legendLongPressTimer) {
      clearTimeout(legendLongPressTimer);
      legendLongPressTimer = null;
    }
    if (legendTipEl) {
      legendTipEl.classList.remove("show");
      legendTipEl.setAttribute("aria-hidden", "true");
    }
    if (legendTipOpenItem) {
      legendTipOpenItem.classList.remove("is-tip-open");
      legendTipOpenItem = null;
    }
    legendTipPinned = false;
  }

  function positionLegendTip(anchor) {
    if (!legendTipEl || !anchor) return;
    const pad = 8;
    const rect = anchor.getBoundingClientRect();
    const tip = legendTipEl;
    tip.style.left = "0px";
    tip.style.top = "0px";
    tip.classList.add("show");
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + tw > window.innerWidth - pad) left = window.innerWidth - tw - pad;
    if (left < pad) left = pad;
    if (top + th > window.innerHeight - pad) top = rect.top - th - 6;
    if (top < pad) top = pad;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function showLegendTip(item, { pin = false } = {}) {
    if (!legendTipEl || !item) return;
    const key = item.getAttribute("data-tip-key");
    const info = LEGEND_TIPS[key];
    if (!info) return;
    if (legendTipOpenItem && legendTipOpenItem !== item) {
      legendTipOpenItem.classList.remove("is-tip-open");
    }
    legendTipOpenItem = item;
    item.classList.add("is-tip-open");
    const nameEl = legendTipEl.querySelector(".lt-name");
    const bodyEl = legendTipEl.querySelector(".lt-body");
    if (nameEl) nameEl.textContent = info.name;
    if (bodyEl) bodyEl.textContent = info.body;
    legendTipEl.setAttribute("aria-hidden", "false");
    positionLegendTip(item);
    legendTipPinned = !!pin;
  }

  function bindLegendTips() {
    const items = document.querySelectorAll(".legend-item[data-tip-key]");
    items.forEach((item) => {
      const key = item.getAttribute("data-tip-key");
      const info = LEGEND_TIPS[key];
      if (info) {
        item.setAttribute("aria-label", `${info.name}：${info.body}`);
      }
      item.addEventListener("mouseenter", () => {
        if (!("ontouchstart" in window)) showLegendTip(item);
      });
      item.addEventListener("mouseleave", () => {
        if (!legendTipPinned) hideLegendTip();
      });
      item.addEventListener("focus", () => showLegendTip(item, { pin: true }));
      item.addEventListener("blur", () => hideLegendTip());
      item.addEventListener(
        "touchstart",
        (e) => {
          if (legendLongPressTimer) clearTimeout(legendLongPressTimer);
          legendLongPressTimer = setTimeout(() => {
            legendLongPressTimer = null;
            showLegendTip(item, { pin: true });
          }, 420);
        },
        { passive: true }
      );
      item.addEventListener(
        "touchend",
        () => {
          if (legendLongPressTimer) {
            clearTimeout(legendLongPressTimer);
            legendLongPressTimer = null;
            // short tap: toggle tip
            if (legendTipOpenItem === item && legendTipPinned) hideLegendTip();
            else showLegendTip(item, { pin: true });
          }
        },
        { passive: true }
      );
      item.addEventListener(
        "touchmove",
        () => {
          if (legendLongPressTimer) {
            clearTimeout(legendLongPressTimer);
            legendLongPressTimer = null;
          }
        },
        { passive: true }
      );
      item.addEventListener("click", (e) => {
        // desktop click / keyboard: toggle pin
        if ("ontouchstart" in window) return;
        e.preventDefault();
        if (legendTipOpenItem === item && legendTipPinned) hideLegendTip();
        else showLegendTip(item, { pin: true });
      });
      item.addEventListener("keydown", (e) => {
        if (e.key === "Escape") hideLegendTip();
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (legendTipOpenItem === item && legendTipPinned) hideLegendTip();
          else showLegendTip(item, { pin: true });
        }
      });
    });
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!legendTipOpenItem) return;
        const t = e.target;
        if (t && (t.closest && (t.closest(".legend-item") || t.closest("#legendTip")))) return;
        hideLegendTip();
      },
      true
    );
    window.addEventListener("scroll", () => {
      if (legendTipOpenItem) positionLegendTip(legendTipOpenItem);
    }, true);
    window.addEventListener("resize", () => {
      if (legendTipOpenItem) positionLegendTip(legendTipOpenItem);
    });
  }

  bindLegendTips();


  setSettingsCollapsed(readStoredCollapsed(), { persist: false });

  // If user rotates / resizes across breakpoint with no stored pref, keep current;
  // stored pref always wins (already applied).

  // Defaults
  $("alignPrices").checked = true;
  updateZoomLabel();

  if (location.protocol !== "file:") {
    fetchAndBuild();
  }
})();
