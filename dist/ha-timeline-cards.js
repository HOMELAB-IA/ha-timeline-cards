/*!
 * ha-timeline-cards.js — v1.0.0
 * Deux cartes Lovelace "analyseur logique" pour Home Assistant :
 *   - custom:automation-timeline-card : frise glissante des automatisations en cours,
 *     chevauchements, conflits d'entités, erreurs de log.
 *   - custom:presence-timeline-card   : frise glissante de la présence (person /
 *     device_tracker / capteurs motion-occupancy), flapping, ghost motion, désync.
 *
 * Aucune dépendance externe, aucun build. Canvas + WebSocket HA.
 * Auteur : généré pour le projet HA Sentinel. Licence : MIT.
 */

const TL_VERSION = "1.0.0";

/* eslint-disable no-console */
console.info(
  `%c HA-TIMELINE-CARDS %c v${TL_VERSION} `,
  "color:#0b1020;background:#7ee787;font-weight:700;padding:2px 4px;border-radius:3px 0 0 3px",
  "color:#7ee787;background:#0b1020;padding:2px 4px;border-radius:0 3px 3px 0"
);

/* ============================================================
 * 1. Utilitaires
 * ==========================================================*/

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* Safari < 16 / vieux WebView Android : pas de roundRect */
if (typeof CanvasRenderingContext2D !== "undefined" && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    const rr = Math.min(typeof r === "number" ? r : 0, Math.abs(w) / 2, Math.abs(h) / 2);
    this.moveTo(x + rr, y);
    this.arcTo(x + w, y, x + w, y + h, rr);
    this.arcTo(x + w, y + h, x, y + h, rr);
    this.arcTo(x, y + h, x, y, rr);
    this.arcTo(x, y, x + w, y, rr);
    this.closePath();
    return this;
  };
}

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

function fmtDur(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60000)}m${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}s`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0") +
    ":" +
    String(d.getSeconds()).padStart(2, "0") +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

/** glob simple : automation.volet_*  /  *_nuit  /  regex si /.../ */
function globToRe(pattern) {
  if (pattern.length > 2 && pattern[0] === "/" && pattern[pattern.length - 1] === "/") {
    try {
      return new RegExp(pattern.slice(1, -1));
    } catch (e) {
      return null;
    }
  }
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

function matchAny(id, patterns) {
  if (!patterns || !patterns.length) return false;
  return patterns.some((p) => {
    const re = globToRe(String(p));
    return re ? re.test(id) : false;
  });
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Extrait les entity_id ciblés par un événement call_service. */
function serviceTargets(data) {
  const out = new Set();
  const push = (v) => asArray(v).forEach((e) => typeof e === "string" && out.add(e));
  const sd = data.service_data || {};
  push(sd.entity_id);
  if (sd.target) push(sd.target.entity_id);
  if (data.target) push(data.target.entity_id);
  return [...out];
}

/* ============================================================
 * 2. Cœur : lanes, spans, marqueurs
 * ==========================================================*/

const MARKER = {
  ERROR: "error",
  CONFLICT: "conflict",
  WARN: "warn",
  TRIGGER: "trigger",
};

class TimelineCore {
  constructor() {
    this.lanes = new Map(); // id -> lane
    this.order = [];
    this.globalMarkers = [];
  }

  lane(id, label, kind = "generic") {
    let l = this.lanes.get(id);
    if (!l) {
      l = {
        id,
        label,
        kind,
        hue: hashHue(id),
        spans: [],
        markers: [],
        open: null,
        lastActivity: 0,
        counters: { runs: 0, errors: 0, conflicts: 0, transitions: 0 },
        pinned: false,
      };
      this.lanes.set(id, l);
      this.order.push(id);
    }
    if (label && l.label !== label) l.label = label;
    return l;
  }

  openSpan(laneId, span) {
    const l = this.lanes.get(laneId) || this.lane(laneId, laneId);
    if (l.open) this.closeSpan(laneId, span.start); // sécurité : pas de span orphelin
    l.open = Object.assign({ start: span.start, end: null }, span);
    l.spans.push(l.open);
    l.lastActivity = span.start;
    return l.open;
  }

  closeSpan(laneId, t, patch) {
    const l = this.lanes.get(laneId);
    if (!l || !l.open) return null;
    l.open.end = t;
    if (patch) Object.assign(l.open, patch);
    const s = l.open;
    l.open = null;
    l.lastActivity = t;
    return s;
  }

  addMarker(laneId, m) {
    const l = laneId ? this.lanes.get(laneId) : null;
    if (l) {
      l.markers.push(m);
      l.lastActivity = Math.max(l.lastActivity, m.t);
      if (m.type === MARKER.ERROR) l.counters.errors++;
      if (m.type === MARKER.CONFLICT) l.counters.conflicts++;
    } else {
      this.globalMarkers.push(m);
    }
  }

  /** Supprime ce qui est sorti de la fenêtre, évince les lanes inactives. */
  prune(now, windowMs, idleEvictMs) {
    const floor = now - windowMs - 2000;
    for (const id of [...this.order]) {
      const l = this.lanes.get(id);
      if (!l) continue;
      l.spans = l.spans.filter((s) => s.end == null || s.end >= floor);
      l.markers = l.markers.filter((m) => m.t >= floor);
      const idle = !l.open && !l.spans.length && !l.markers.length;
      if (idle && !l.pinned && now - l.lastActivity > idleEvictMs) {
        this.lanes.delete(id);
        this.order = this.order.filter((x) => x !== id);
      }
    }
    this.globalMarkers = this.globalMarkers.filter((m) => m.t >= floor);
  }

  visibleLanes(maxLanes) {
    const arr = this.order.map((id) => this.lanes.get(id)).filter(Boolean);
    arr.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (!!a.open !== !!b.open) return a.open ? -1 : 1;
      return b.lastActivity - a.lastActivity;
    });
    return arr.slice(0, maxLanes);
  }

  /** Nombre de spans simultanés, échantillonné (pour la bande de concurrence). */
  concurrency(now, windowMs, samples) {
    const t0 = now - windowMs;
    const step = windowMs / samples;
    const out = new Array(samples).fill(0);
    for (const l of this.lanes.values()) {
      for (const s of l.spans) {
        const e = s.end == null ? now : s.end;
        if (e < t0 || s.start > now) continue;
        const i0 = clamp(Math.floor((s.start - t0) / step), 0, samples - 1);
        const i1 = clamp(Math.ceil((e - t0) / step), 0, samples);
        for (let i = i0; i < i1; i++) out[i]++;
      }
    }
    return out;
  }
}

/* ============================================================
 * 3. Rendu canvas
 * ==========================================================*/

const GEO = {
  labelW: 172,
  headerH: 22,
  summaryH: 30,
  laneH: 26,
  laneGap: 4,
  padR: 14,
  padTop: 6,
  padBottom: 20,
};

function readTheme(el) {
  const cs = getComputedStyle(el);
  const g = (n, f) => (cs.getPropertyValue(n) || "").trim() || f;
  return {
    text: g("--primary-text-color", "#e6edf3"),
    dim: g("--secondary-text-color", "#8b949e"),
    grid: g("--divider-color", "rgba(127,127,127,.28)"),
    bg: g("--ha-card-background", g("--card-background-color", "#111418")),
    accent: g("--primary-color", "#03a9f4"),
    error: g("--error-color", "#ff5370"),
    warn: g("--warning-color", "#ffb454"),
    ok: g("--success-color", "#7ee787"),
  };
}

function drawTimeline(ctx, opts) {
  const { core, now, windowMs, theme, W, H, lanes, paused, hover, summaryLabel, laneSubLabel } = opts;
  const plotX = GEO.labelW;
  const plotW = W - plotX - GEO.padR;
  const t0 = now - windowMs;
  const xOf = (t) => plotX + ((t - t0) / windowMs) * plotW;

  ctx.clearRect(0, 0, W, H);
  ctx.textBaseline = "middle";

  /* --- graduations --- */
  const stepS = windowMs <= 20000 ? 2 : windowMs <= 45000 ? 5 : windowMs <= 120000 ? 10 : 30;
  ctx.font = "10px ui-monospace,SFMono-Regular,Menlo,monospace";
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  for (let s = 0; s <= windowMs / 1000; s += stepS) {
    const t = now - s * 1000;
    const x = Math.round(xOf(t)) + 0.5;
    ctx.globalAlpha = s === 0 ? 0.0 : 0.45;
    ctx.beginPath();
    ctx.moveTo(x, GEO.padTop + GEO.headerH);
    ctx.lineTo(x, H - GEO.padBottom);
    ctx.stroke();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = theme.dim;
    ctx.textAlign = "center";
    ctx.fillText(s === 0 ? "now" : `-${s}s`, x, H - GEO.padBottom + 9);
  }
  ctx.globalAlpha = 1;

  /* --- bande de concurrence --- */
  const sy = GEO.padTop + GEO.headerH;
  const samples = Math.max(60, Math.floor(plotW / 2));
  const conc = core.concurrency(now, windowMs, samples);
  const maxC = Math.max(1, ...conc);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(plotX, sy + GEO.summaryH);
  for (let i = 0; i < samples; i++) {
    const x = plotX + (i / (samples - 1)) * plotW;
    const y = sy + GEO.summaryH - (conc[i] / maxC) * (GEO.summaryH - 6);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(plotX + plotW, sy + GEO.summaryH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, sy, 0, sy + GEO.summaryH);
  grad.addColorStop(0, theme.accent + "66");
  grad.addColorStop(1, theme.accent + "0d");
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = theme.accent;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();

  ctx.font = "10px ui-monospace,SFMono-Regular,Menlo,monospace";
  ctx.fillStyle = theme.dim;
  ctx.textAlign = "right";
  ctx.fillText(summaryLabel, plotX - 10, sy + GEO.summaryH / 2);
  ctx.textAlign = "left";
  ctx.fillText(`max ${maxC}`, plotX + 6, sy + 8);

  /* --- lanes --- */
  let y = sy + GEO.summaryH + 8;
  const rows = [];
  for (const l of lanes) {
    const rowY = y;
    const h = GEO.laneH;
    rows.push({ lane: l, y: rowY, h });

    // fond de piste
    ctx.fillStyle = theme.grid;
    ctx.globalAlpha = 0.1;
    ctx.fillRect(plotX, rowY, plotW, h);
    ctx.globalAlpha = 1;

    // libellé
    ctx.font = "12px var(--ha-card-header-font-family, inherit)";
    ctx.fillStyle = l.open ? theme.text : theme.dim;
    ctx.textAlign = "left";
    const label = l.label.length > 26 ? l.label.slice(0, 25) + "…" : l.label;
    ctx.fillText(label, 10, rowY + h / 2 - (laneSubLabel ? 5 : 0));
    if (laneSubLabel) {
      const sub = laneSubLabel(l);
      if (sub) {
        ctx.font = "9px ui-monospace,SFMono-Regular,Menlo,monospace";
        ctx.fillStyle = theme.dim;
        ctx.globalAlpha = 0.8;
        ctx.fillText(sub, 10, rowY + h / 2 + 7);
        ctx.globalAlpha = 1;
      }
    }
    // pastille couleur
    ctx.fillStyle = `hsl(${l.hue} 65% 55%)`;
    ctx.fillRect(2, rowY + 4, 3, h - 8);

    // spans
    for (const s of l.spans) {
      const e = s.end == null ? now : s.end;
      if (e < t0) continue;
      const x1 = Math.max(plotX, xOf(Math.max(s.start, t0)));
      const x2 = clamp(xOf(e), plotX, plotX + plotW);
      const w = Math.max(2, x2 - x1);
      const color = s.color || `hsl(${l.hue} 65% 55%)`;
      ctx.fillStyle = color;
      ctx.globalAlpha = s.end == null ? 0.95 : 0.72;
      const r = Math.min(3, w / 2);
      ctx.beginPath();
      ctx.roundRect(x1, rowY + 5, w, h - 10, r);
      ctx.fill();
      ctx.globalAlpha = 1;

      if (s.start < t0) {
        // span tronqué à gauche : marque de continuation
        ctx.fillStyle = theme.bg;
        for (let k = 0; k < 3; k++) ctx.fillRect(plotX + k * 3, rowY + 5, 1.2, h - 10);
      }
      if (s.end == null) {
        // tête vive
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x2, rowY + h / 2, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      if (w > 42 && s.text) {
        ctx.font = "10px ui-monospace,SFMono-Regular,Menlo,monospace";
        ctx.fillStyle = "rgba(0,0,0,.72)";
        ctx.textAlign = "left";
        ctx.save();
        ctx.beginPath();
        ctx.rect(x1, rowY, w, h);
        ctx.clip();
        ctx.fillText(s.text, x1 + 5, rowY + h / 2);
        ctx.restore();
      }
    }

    // marqueurs
    for (const m of l.markers) {
      if (m.t < t0) continue;
      const x = xOf(m.t);
      drawMarker(ctx, x, rowY + h / 2, m.type, theme);
    }

    y += h + GEO.laneGap;
  }

  /* --- marqueurs globaux (bandeau bas) --- */
  for (const m of core.globalMarkers) {
    if (m.t < t0) continue;
    drawMarker(ctx, xOf(m.t), H - GEO.padBottom - 6, m.type, theme);
  }

  /* --- ligne "now" --- */
  const nx = Math.round(xOf(now)) + 0.5;
  ctx.strokeStyle = paused ? theme.warn : theme.accent;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.5;
  ctx.setLineDash(paused ? [4, 3] : []);
  ctx.beginPath();
  ctx.moveTo(nx, GEO.padTop + GEO.headerH);
  ctx.lineTo(nx, H - GEO.padBottom);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  /* --- curseur de survol --- */
  if (hover && hover.x > plotX) {
    ctx.strokeStyle = theme.text;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.moveTo(hover.x + 0.5, GEO.padTop + GEO.headerH);
    ctx.lineTo(hover.x + 0.5, H - GEO.padBottom);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // séparateur colonne libellés
  ctx.strokeStyle = theme.grid;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(plotX - 0.5, GEO.padTop);
  ctx.lineTo(plotX - 0.5, H - GEO.padBottom);
  ctx.stroke();
  ctx.globalAlpha = 1;

  return { rows, plotX, plotW, t0, xOf };
}

function drawMarker(ctx, x, y, type, theme) {
  ctx.save();
  ctx.translate(x, y);
  if (type === MARKER.ERROR) {
    ctx.strokeStyle = theme.error;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-4, -4);
    ctx.lineTo(4, 4);
    ctx.moveTo(4, -4);
    ctx.lineTo(-4, 4);
    ctx.stroke();
  } else if (type === MARKER.CONFLICT) {
    ctx.fillStyle = theme.error;
    ctx.beginPath();
    ctx.moveTo(0, -5.5);
    ctx.lineTo(5.5, 0);
    ctx.lineTo(0, 5.5);
    ctx.lineTo(-5.5, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,.65)";
    ctx.fillRect(-0.8, -2.6, 1.6, 3.4);
    ctx.fillRect(-0.8, 1.4, 1.6, 1.4);
  } else if (type === MARKER.WARN) {
    ctx.fillStyle = theme.warn;
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(5, 4);
    ctx.lineTo(-5, 4);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.arc(0, 0, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* ============================================================
 * 4. Carte de base
 * ==========================================================*/

class TimelineCardBase extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._core = new TimelineCore();
    this._subs = [];
    this._raf = null;
    this._paused = false;
    this._hover = null;
    this._geom = null;
    this._ready = false;
    this._pausedAt = 0;
    this._onResize = () => this._resize();
  }

  /* ---- config ---- */
  setConfig(config) {
    this._config = Object.assign(this._defaults(), config || {});
    this._config.window = clamp(Number(this._config.window) || 60, 5, 600);
    this._config.max_lanes = clamp(Number(this._config.max_lanes) || 12, 1, 40);
    if (this._ready) this._rebuild();
  }

  _defaults() {
    return { window: 60, max_lanes: 12, backfill: true, idle_evict: 45 };
  }

  get windowMs() {
    return this._config.window * 1000;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first && this.isConnected) this._start();
  }

  getCardSize() {
    return 3 + Math.ceil((this._config?.max_lanes || 8) / 3);
  }

  /* ---- cycle de vie ---- */
  connectedCallback() {
    if (!this.shadowRoot.firstChild) this._buildDom();
    window.addEventListener("resize", this._onResize);
    document.addEventListener("visibilitychange", this._onResize);
    if (this._hass) this._start();
  }

  disconnectedCallback() {
    this._stop();
    window.removeEventListener("resize", this._onResize);
    document.removeEventListener("visibilitychange", this._onResize);
  }

  _buildDom() {
    const style = document.createElement("style");
    style.textContent = `
      :host { display:block; }
      ha-card { padding: 10px 8px 4px; overflow:hidden; position:relative; }
      .hdr { display:flex; align-items:center; gap:10px; padding:0 6px 6px; }
      .title { font-size:15px; font-weight:600; color:var(--primary-text-color); flex:0 0 auto; }
      .stats { display:flex; gap:12px; font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
               color:var(--secondary-text-color); flex:1 1 auto; flex-wrap:wrap; }
      .stats b { font-weight:700; }
      .stats .k-err b { color: var(--error-color, #ff5370); }
      .stats .k-cfl b { color: var(--error-color, #ff5370); }
      .stats .k-run b { color: var(--primary-color); }
      .btns { display:flex; gap:4px; }
      button { background:transparent; border:1px solid var(--divider-color); color:var(--secondary-text-color);
               border-radius:6px; font:11px ui-monospace,monospace; padding:3px 7px; cursor:pointer; }
      button:hover { color:var(--primary-text-color); border-color:var(--primary-color); }
      button[aria-pressed="true"] { color:var(--primary-color); border-color:var(--primary-color); }
      button:focus-visible { outline:2px solid var(--primary-color); outline-offset:1px; }
      canvas { display:block; width:100%; cursor:crosshair; }
      .tip { position:absolute; pointer-events:none; z-index:5; max-width:300px;
             background:var(--card-background-color,#1c1f24); color:var(--primary-text-color);
             border:1px solid var(--divider-color); border-radius:8px; padding:7px 9px;
             font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;
             box-shadow:0 6px 24px rgba(0,0,0,.45); opacity:0; transition:opacity .09s; }
      .tip.on { opacity:1; }
      .tip .t { font-weight:700; margin-bottom:2px; }
      .tip .d { color:var(--secondary-text-color); }
      .empty { padding:22px 10px; text-align:center; color:var(--secondary-text-color); font-size:12px; }
      @media (prefers-reduced-motion: reduce) { canvas { transition:none } }
    `;
    const card = document.createElement("ha-card");
    card.innerHTML = `
      <div class="hdr">
        <div class="title"></div>
        <div class="stats"></div>
        <div class="btns">
          <button class="w" title="Fenêtre affichée">60s</button>
          <button class="p" aria-pressed="false" title="Geler la frise (espace)">Pause</button>
          <button class="c" title="Vider la frise">Clear</button>
        </div>
      </div>
      <canvas></canvas>
      <div class="tip"></div>
    `;
    this.shadowRoot.append(style, card);

    this._el = {
      card,
      title: card.querySelector(".title"),
      stats: card.querySelector(".stats"),
      canvas: card.querySelector("canvas"),
      tip: card.querySelector(".tip"),
      bw: card.querySelector("button.w"),
      bp: card.querySelector("button.p"),
      bc: card.querySelector("button.c"),
    };
    this._ctx = this._el.canvas.getContext("2d");

    this._el.bp.addEventListener("click", () => this._togglePause());
    this._el.bc.addEventListener("click", () => {
      this._core = new TimelineCore();
      this._seedLanes?.();
    });
    this._el.bw.addEventListener("click", () => {
      const steps = [15, 30, 60, 120];
      const i = steps.indexOf(this._config.window);
      this._config.window = steps[(i + 1) % steps.length];
      this._el.bw.textContent = `${this._config.window}s`;
    });
    this._el.canvas.addEventListener("mousemove", (e) => this._onMove(e));
    this._el.canvas.addEventListener("mouseleave", () => {
      this._hover = null;
      this._el.tip.classList.remove("on");
    });
    this._el.canvas.addEventListener("click", (e) => this._onClick(e));
    this.tabIndex = 0;
    this.addEventListener("keydown", (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        this._togglePause();
      }
    });
  }

  _togglePause() {
    this._paused = !this._paused;
    this._pausedAt = Date.now();
    this._el.bp.setAttribute("aria-pressed", String(this._paused));
    this._el.bp.textContent = this._paused ? "Live" : "Pause";
  }

  _now() {
    return this._paused ? this._pausedAt : Date.now();
  }

  async _start() {
    if (this._running) return;
    this._running = true;
    this._ready = true;
    this._el.title.textContent = this._config.title ?? this._defaultTitle();
    this._el.bw.textContent = `${this._config.window}s`;
    this._resize();
    try {
      this._seedLanes?.();
      await this._subscribe();
      if (this._config.backfill) await this._backfill().catch(() => {});
    } catch (err) {
      console.error("[ha-timeline-cards] init", err);
    }
    this._loop();
  }

  _stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._subs.forEach((u) => {
      try {
        u();
      } catch (e) {
        /* noop */
      }
    });
    this._subs = [];
  }

  async _rebuild() {
    this._stop();
    this._core = new TimelineCore();
    if (this._hass && this.isConnected) this._start();
  }

  _resize() {
    const c = this._el.canvas;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth || 600;
    const nLanes = Math.max(1, this._core.visibleLanes(this._config.max_lanes).length);
    const cssH =
      GEO.padTop + GEO.headerH + GEO.summaryH + 8 + nLanes * (GEO.laneH + GEO.laneGap) + GEO.padBottom;
    c.style.height = `${cssH}px`;
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._cssW = cssW;
    this._cssH = cssH;
    this._theme = readTheme(this._el.card);
  }

  _loop() {
    if (!this._running) return;
    this._raf = requestAnimationFrame(() => this._loop());
    if (document.hidden) return;
    const now = this._now();
    this._analyze?.(now);
    this._core.prune(Date.now(), this.windowMs, (this._config.idle_evict || 45) * 1000);
    const lanes = this._core.visibleLanes(this._config.max_lanes);
    const wantH =
      GEO.padTop + GEO.headerH + GEO.summaryH + 8 + Math.max(1, lanes.length) * (GEO.laneH + GEO.laneGap) + GEO.padBottom;
    if (Math.abs(wantH - this._cssH) > 1 || this._el.canvas.clientWidth !== this._cssW) this._resize();
    this._geom = drawTimeline(this._ctx, {
      core: this._core,
      now,
      windowMs: this.windowMs,
      theme: this._theme,
      W: this._cssW,
      H: this._cssH,
      lanes,
      paused: this._paused,
      hover: this._hover,
      summaryLabel: this._summaryLabel(),
      laneSubLabel: this._laneSubLabel?.bind(this),
    });
    this._el.stats.innerHTML = this._statsHtml(lanes, now);
  }

  /* ---- interaction ---- */
  _hit(e) {
    const r = this._el.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (!this._geom) return null;
    const { rows, t0, xOf } = this._geom;
    const t = t0 + ((x - this._geom.plotX) / this._geom.plotW) * this.windowMs;
    const row = rows.find((rr) => y >= rr.y && y <= rr.y + rr.h);
    if (!row) return { x, y, t };
    const now = this._now();
    const marker = row.lane.markers.find((m) => Math.abs(xOf(m.t) - x) < 6);
    const span = row.lane.spans.find((s) => {
      const e2 = s.end == null ? now : s.end;
      return t >= s.start - 150 && t <= e2 + 150;
    });
    return { x, y, t, lane: row.lane, span, marker };
  }

  _onMove(e) {
    const h = this._hit(e);
    this._hover = h;
    const tip = this._el.tip;
    if (!h || (!h.span && !h.marker && !h.lane)) {
      tip.classList.remove("on");
      return;
    }
    tip.innerHTML = this._tipHtml(h);
    tip.classList.add("on");
    const cw = this._el.card.clientWidth;
    const left = clamp(h.x + 14, 6, Math.max(6, cw - tip.offsetWidth - 6));
    tip.style.left = `${left}px`;
    tip.style.top = `${h.y + this._el.canvas.offsetTop + 16}px`;
  }

  _onClick(e) {
    const h = this._hit(e);
    if (!h || !h.lane) return;
    const entity = h.lane.entity || h.lane.id;
    if (!this._hass?.states?.[entity]) return;
    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        detail: { entityId: entity },
        bubbles: true,
        composed: true,
      })
    );
  }

  /* ---- helpers websocket ---- */
  async _sub(type, cb) {
    const un = await this._hass.connection.subscribeEvents(cb, type);
    this._subs.push(un);
  }

  async _history(entityIds, seconds, withAttributes) {
    const end = new Date();
    const start = new Date(end.getTime() - seconds * 1000);
    return this._hass.callWS({
      type: "history/history_during_period",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      entity_ids: entityIds,
      minimal_response: false,
      no_attributes: !withAttributes,
      significant_changes_only: false,
    });
  }

  /* ---- à implémenter ---- */
  _defaultTitle() {
    return "Timeline";
  }
  _summaryLabel() {
    return "concurrence";
  }
  _statsHtml() {
    return "";
  }
  _tipHtml() {
    return "";
  }
  async _subscribe() {}
  async _backfill() {}
}

/* ============================================================
 * 5. Carte AUTOMATISATIONS
 * ==========================================================*/

class AutomationTimelineCard extends TimelineCardBase {
  _defaults() {
    return {
      window: 60,
      max_lanes: 14,
      backfill: true,
      idle_evict: 45,
      include: [],
      exclude: [],
      pinned: [],
      include_scripts: false,
      show_errors: true,
      show_conflicts: true,
      conflict_window: 5, // s : deux écritures sur la même entité dans cette fenêtre = conflit
      stuck_after: 30, // s : une automatisation qui tourne plus longtemps = warning
      synthetic_span: 400, // ms : durée affichée si l'attribut `current` est absent
    };
  }

  _defaultTitle() {
    return "Automatisations — frise temps réel";
  }
  _summaryLabel() {
    return "en parallèle";
  }

  constructor() {
    super();
    this._ctxOwner = new Map(); // context.id -> laneId
    this._ctxParent = new Map(); // context.id -> parent_id
    this._writes = []; // {t, entity, laneId, service}
    this._stuckFlagged = new Set();
  }

  _domains() {
    return this._config.include_scripts ? ["automation.", "script."] : ["automation."];
  }

  _accept(entityId) {
    if (!this._domains().some((d) => entityId.startsWith(d))) return false;
    if (this._config.exclude?.length && matchAny(entityId, this._config.exclude)) return false;
    if (this._config.include?.length) return matchAny(entityId, this._config.include);
    return true;
  }

  _seedLanes() {
    for (const p of this._config.pinned || []) {
      const st = this._hass?.states?.[p];
      const l = this._core.lane(p, st?.attributes?.friendly_name || p, "automation");
      l.pinned = true;
      l.entity = p;
      l.lastActivity = Date.now();
    }
  }

  _laneOf(entityId) {
    const st = this._hass?.states?.[entityId];
    const l = this._core.lane(entityId, st?.attributes?.friendly_name || entityId, "automation");
    l.entity = entityId;
    return l;
  }

  /* --- résolution de contexte : remonte la chaîne parent --- */
  _ownerOf(context) {
    if (!context) return null;
    let id = context.id;
    for (let i = 0; i < 6 && id; i++) {
      const owner = this._ctxOwner.get(id);
      if (owner) return owner;
      id = this._ctxParent.get(id) || (i === 0 ? context.parent_id : null);
    }
    return null;
  }

  _noteContext(context, laneId) {
    if (!context) return;
    if (context.parent_id) this._ctxParent.set(context.id, context.parent_id);
    if (laneId) this._ctxOwner.set(context.id, laneId);
    if (this._ctxOwner.size > 4000) {
      // garde-fou mémoire
      this._ctxOwner = new Map([...this._ctxOwner].slice(-1500));
      this._ctxParent = new Map([...this._ctxParent].slice(-1500));
    }
  }

  async _subscribe() {
    await this._sub("automation_triggered", (ev) => this._onTriggered(ev));
    await this._sub("state_changed", (ev) => this._onStateChanged(ev));
    if (this._config.show_conflicts) await this._sub("call_service", (ev) => this._onCallService(ev));
    if (this._config.show_errors) {
      try {
        await this._sub("system_log_event", (ev) => this._onLog(ev));
      } catch (e) {
        console.warn("[ha-timeline-cards] system_log_event indisponible", e);
      }
    }
  }

  _onTriggered(ev) {
    const id = ev.data?.entity_id;
    if (!id || !this._accept(id)) return;
    const l = this._laneOf(id);
    l.counters.runs++;
    this._noteContext(ev.context, id);
    l.lastActivity = Date.now();
    l.lastTrigger = ev.data?.source || "?";
    if (!l.open) {
      // filet de sécurité : si `current` n'arrive pas, on aura au moins une trace
      l.pendingTrigger = { t: Date.now(), source: l.lastTrigger };
    } else {
      l.open.text = l.open.text || l.lastTrigger;
    }
  }

  _onStateChanged(ev) {
    const id = ev.data?.entity_id;
    if (!id) return;
    if (this._accept(id)) {
      this._noteContext(ev.context, null);
      const ns = ev.data.new_state,
        os = ev.data.old_state;
      const cur = Number(ns?.attributes?.current ?? NaN);
      const prev = Number(os?.attributes?.current ?? NaN);
      const t = Date.now();
      const l = this._laneOf(id);

      if (!Number.isNaN(cur) && !Number.isNaN(prev)) {
        if (cur > prev) {
          if (!l.open) {
            const src = l.pendingTrigger?.source || "";
            const start = l.pendingTrigger ? Math.min(l.pendingTrigger.t, t) : t;
            this._core.openSpan(id, { start, text: src, ctx: ns.context?.id });
            l.pendingTrigger = null;
          }
          if (cur > 1) {
            this._core.addMarker(id, {
              t,
              type: MARKER.WARN,
              title: "Instances parallèles",
              text: `${cur} exécutions simultanées de la même automatisation (mode parallel/queued)`,
            });
          }
        } else if (cur < prev && cur === 0) {
          this._core.closeSpan(id, t);
          this._stuckFlagged.delete(id);
        }
      } else if (ns?.attributes?.last_triggered !== os?.attributes?.last_triggered) {
        // pas d'attribut `current` : span synthétique
        const start = t;
        this._core.openSpan(id, {
          start,
          text: "≈",
          synthetic: true,
        });
        setTimeout(() => this._core.closeSpan(id, Date.now()), this._config.synthetic_span);
      }
      return;
    }

    // écriture d'état attribuable à une automatisation → détection de conflit
    if (!this._config.show_conflicts) return;
    const owner = this._ownerOf(ev.context);
    if (!owner) return;
    if (ev.data.old_state?.state === ev.data.new_state?.state) return;
    this._recordWrite(Date.now(), id, owner, "state");
  }

  _onCallService(ev) {
    const owner = this._ownerOf(ev.context);
    this._noteContext(ev.context, owner);
    if (!owner) return;
    const targets = serviceTargets(ev.data || {});
    const svc = `${ev.data.domain}.${ev.data.service}`;
    const t = Date.now();
    if (!targets.length) return;
    for (const tgt of targets) this._recordWrite(t, tgt, owner, svc);
  }

  _recordWrite(t, entity, laneId, service) {
    const win = (this._config.conflict_window || 5) * 1000;
    for (let i = this._writes.length - 1; i >= 0; i--) {
      const w = this._writes[i];
      if (t - w.t > win) break;
      if (w.entity === entity && w.laneId !== laneId) {
        const otherLabel = this._core.lanes.get(w.laneId)?.label || w.laneId;
        const selfLabel = this._core.lanes.get(laneId)?.label || laneId;
        const info = {
          type: MARKER.CONFLICT,
          t,
          title: "Conflit d'entité",
          text: `${entity}\nécrit par « ${selfLabel} » (${service}) et « ${otherLabel} » (${w.service}) à ${fmtDur(
            t - w.t
          )} d'écart`,
        };
        this._core.addMarker(laneId, info);
        this._core.addMarker(w.laneId, Object.assign({}, info));
        break;
      }
    }
    this._writes.push({ t, entity, laneId, service });
    if (this._writes.length > 600) this._writes.splice(0, 300);
  }

  _onLog(ev) {
    const d = ev.data || {};
    const level = (d.level || "").toUpperCase();
    if (level !== "ERROR" && level !== "WARNING" && level !== "CRITICAL") return;
    const msg = asArray(d.message).join(" ");
    const name = d.name || "";
    const hay = `${name} ${msg}`.toLowerCase();
    const t = Date.now();

    let laneId = null;
    for (const l of this._core.lanes.values()) {
      const slug = l.id.split(".")[1] || "";
      if (hay.includes(slug) || (l.label && hay.includes(l.label.toLowerCase()))) {
        laneId = l.id;
        break;
      }
    }
    const marker = {
      t,
      type: level === "WARNING" ? MARKER.WARN : MARKER.ERROR,
      title: level === "WARNING" ? "Warning" : "Erreur",
      text: `${name}\n${msg.slice(0, 260)}`,
    };
    this._core.addMarker(laneId, marker);
  }

  _analyze(now) {
    const stuck = (this._config.stuck_after || 30) * 1000;
    for (const l of this._core.lanes.values()) {
      if (l.open && now - l.open.start > stuck && !this._stuckFlagged.has(l.id)) {
        this._stuckFlagged.add(l.id);
        this._core.addMarker(l.id, {
          t: now,
          type: MARKER.WARN,
          title: "Exécution longue",
          text: `Toujours en cours après ${fmtDur(now - l.open.start)} — delay/wait_template bloquant ?`,
        });
      }
      // pendingTrigger jamais confirmé par `current` (>2s) → trace fine
      if (l.pendingTrigger && now - l.pendingTrigger.t > 2000) {
        this._core.addMarker(l.id, {
          t: l.pendingTrigger.t,
          type: MARKER.TRIGGER,
          title: "Déclenchement",
          text: `Source : ${l.pendingTrigger.source} (durée non mesurable)`,
        });
        l.pendingTrigger = null;
      }
    }
  }

  async _backfill() {
    const ids = Object.keys(this._hass.states).filter((id) => this._accept(id));
    if (!ids.length) return;
    const recent = ids.filter((id) => {
      const lt = this._hass.states[id].attributes?.last_triggered;
      return lt && Date.now() - new Date(lt).getTime() < this.windowMs;
    });
    const targets = [...new Set([...(this._config.pinned || []), ...recent])];
    if (!targets.length) return;
    const hist = await this._history(targets, this._config.window, true);
    for (const [entity, rows] of Object.entries(hist || {})) {
      let prev = null;
      for (const r of rows) {
        const t = (r.lu || 0) * 1000;
        const cur = Number(r.a?.current ?? NaN);
        if (Number.isNaN(cur)) continue;
        if (prev != null && cur > prev) this._core.openSpan(entity, { start: t, text: "⤓" });
        else if (prev != null && cur < prev && cur === 0) this._core.closeSpan(entity, t);
        prev = cur;
      }
      const l = this._core.lanes.get(entity);
      if (l) l.entity = entity;
    }
  }

  _laneSubLabel(l) {
    const c = l.counters;
    const bits = [];
    if (c.runs) bits.push(`${c.runs}×`);
    if (c.conflicts) bits.push(`⧫${c.conflicts}`);
    if (c.errors) bits.push(`✕${c.errors}`);
    return bits.join(" ");
  }

  _statsHtml(lanes, now) {
    let running = 0,
      conflicts = 0,
      errors = 0,
      runs = 0;
    for (const l of this._core.lanes.values()) {
      if (l.open) running++;
      conflicts += l.counters.conflicts;
      errors += l.counters.errors;
      runs += l.counters.runs;
    }
    errors += this._core.globalMarkers.filter((m) => m.t > now - this.windowMs && m.type === MARKER.ERROR).length;
    return `
      <span class="k-run"><b>${running}</b> en cours</span>
      <span><b>${runs}</b> déclench.</span>
      <span class="k-cfl">⧫ <b>${conflicts}</b> conflits</span>
      <span class="k-err">✕ <b>${errors}</b> erreurs</span>
      <span>${this._core.lanes.size} pistes</span>`;
  }

  _tipHtml(h) {
    if (h.marker) {
      return `<div class="t">${h.marker.title}</div><div>${(h.marker.text || "").replace(
        /\n/g,
        "<br>"
      )}</div><div class="d">${fmtClock(h.marker.t)}</div>`;
    }
    if (h.span) {
      const end = h.span.end == null ? this._now() : h.span.end;
      return `<div class="t">${h.lane.label}</div>
        <div>${h.span.end == null ? "en cours" : "terminée"} · ${fmtDur(end - h.span.start)}</div>
        ${h.span.text ? `<div>déclencheur : ${h.span.text}</div>` : ""}
        <div class="d">${fmtClock(h.span.start)} → ${h.span.end == null ? "…" : fmtClock(h.span.end)}</div>
        <div class="d">${h.lane.id}</div>`;
    }
    return `<div class="t">${h.lane.label}</div><div class="d">${h.lane.id}</div>
      <div class="d">${h.lane.counters.runs} exéc. · ${h.lane.counters.conflicts} conflits · ${h.lane.counters.errors} erreurs</div>`;
  }

  static getStubConfig() {
    return { type: "custom:automation-timeline-card", window: 60, max_lanes: 12 };
  }
}

/* ============================================================
 * 6. Carte PRÉSENCE
 * ==========================================================*/

const PRESENCE_ON = new Set(["home", "on", "detected", "occupied"]);

class PresenceTimelineCard extends TimelineCardBase {
  _defaults() {
    return {
      window: 60,
      max_lanes: 16,
      backfill: true,
      idle_evict: 1e9, // les pistes présence restent affichées
      entities: [],
      auto_discover: true,
      include_device_trackers: true,
      include_motion: true,
      flap_threshold: 4,
      flap_window: 20,
      ghost_motion: true,
      person_desync: true,
      desync_grace: 15,
    };
  }

  _defaultTitle() {
    return "Présence — frise temps réel";
  }
  _summaryLabel() {
    return "présents";
  }

  constructor() {
    super();
    this._flagged = new Map();
  }

  _discover() {
    const cfg = this._config;
    if (cfg.entities?.length) return cfg.entities.filter((e) => this._hass.states[e]);
    if (!cfg.auto_discover) return [];
    const out = [];
    for (const [id, st] of Object.entries(this._hass.states)) {
      const dc = st.attributes?.device_class;
      if (id.startsWith("person.")) out.push(id);
      else if (cfg.include_device_trackers && id.startsWith("device_tracker.")) out.push(id);
      else if (
        cfg.include_motion &&
        id.startsWith("binary_sensor.") &&
        ["motion", "occupancy", "presence"].includes(dc)
      )
        out.push(id);
    }
    // person d'abord, puis trackers, puis capteurs
    const rank = (id) => (id.startsWith("person.") ? 0 : id.startsWith("device_tracker.") ? 1 : 2);
    out.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return out.slice(0, this._config.max_lanes);
  }

  _colorFor(state) {
    const th = this._theme || readTheme(this);
    if (PRESENCE_ON.has(state)) return th.ok;
    if (state === "not_home" || state === "off") return "rgba(130,140,150,.45)";
    if (state === "unavailable" || state === "unknown") return th.error;
    return th.warn; // zone nommée
  }

  _seedLanes() {
    this._entities = this._discover();
    const now = Date.now();
    for (const id of this._entities) {
      const st = this._hass.states[id];
      const l = this._core.lane(id, st?.attributes?.friendly_name || id, "presence");
      l.pinned = true;
      l.entity = id;
      l.lastActivity = now;
      if (!l.open && st) {
        const start = Math.max(now - this.windowMs, new Date(st.last_changed).getTime());
        this._core.openSpan(id, { start, state: st.state, text: st.state, color: this._colorFor(st.state) });
      }
    }
  }

  async _subscribe() {
    await this._sub("state_changed", (ev) => {
      const id = ev.data?.entity_id;
      if (!id || !this._entities?.includes(id)) return;
      const ns = ev.data.new_state;
      const os = ev.data.old_state;
      if (!ns || ns.state === os?.state) return;
      const t = Date.now();
      this._core.closeSpan(id, t);
      this._core.openSpan(id, { start: t, state: ns.state, text: ns.state, color: this._colorFor(ns.state) });
      const l = this._core.lanes.get(id);
      if (l) l.counters.transitions++;
    });
  }

  async _backfill() {
    if (!this._entities?.length) return;
    const hist = await this._history(this._entities, this._config.window, false);
    for (const [entity, rows] of Object.entries(hist || {})) {
      const l = this._core.lanes.get(entity);
      if (!l) continue;
      l.spans = [];
      l.open = null;
      const t0 = Date.now() - this.windowMs;
      for (const r of rows) {
        const t = Math.max(t0, (r.lu || 0) * 1000);
        this._core.closeSpan(entity, t);
        this._core.openSpan(entity, { start: t, state: r.s, text: r.s, color: this._colorFor(r.s) });
      }
      l.counters.transitions = Math.max(0, rows.length - 1);
    }
  }

  _flag(key, laneId, marker, cooldownMs = 12000) {
    const last = this._flagged.get(key) || 0;
    if (marker.t - last < cooldownMs) return;
    this._flagged.set(key, marker.t);
    this._core.addMarker(laneId, marker);
  }

  _analyze(now) {
    const cfg = this._config;
    const win = (cfg.flap_window || 20) * 1000;

    // 1. flapping
    for (const l of this._core.lanes.values()) {
      const trans = l.spans.filter((s) => s.start > now - win).length;
      if (trans >= (cfg.flap_threshold || 4)) {
        this._flag(`flap:${l.id}`, l.id, {
          t: now,
          type: MARKER.WARN,
          title: "Flapping",
          text: `${trans} changements d'état en ${cfg.flap_window}s — tracker instable, seuil trop bas ou conflit de sources`,
        });
      }
    }

    const stateOf = (id) => this._hass?.states?.[id]?.state;
    const persons = (this._entities || []).filter((e) => e.startsWith("person."));
    const anyoneHome = persons.some((p) => stateOf(p) === "home");

    // 2. ghost motion : mouvement détecté alors que personne n'est à la maison
    if (cfg.ghost_motion && persons.length) {
      for (const id of this._entities) {
        if (!id.startsWith("binary_sensor.")) continue;
        if (stateOf(id) !== "on") continue;
        if (anyoneHome) continue;
        this._flag(`ghost:${id}`, id, {
          t: now,
          type: MARKER.CONFLICT,
          title: "Mouvement fantôme",
          text: "Capteur actif alors qu'aucune personne n'est marquée « home » — intrusion, animal, faux positif IR ou présence non trackée",
        });
      }
    }

    // 3. désynchronisation person ↔ device_tracker
    if (cfg.person_desync) {
      for (const p of persons) {
        const st = this._hass.states[p];
        const trackers = st?.attributes?.device_trackers || [];
        if (!trackers.length) continue;
        const states = trackers.map(stateOf).filter(Boolean);
        if (!states.length) continue;
        const lane = this._core.lanes.get(p);
        const stable = lane?.open && now - lane.open.start > (cfg.desync_grace || 15) * 1000;
        if (!stable) continue;

        const anyHome = states.includes("home");
        if (st.state === "home" && !anyHome) {
          this._flag(`desync:${p}`, p, {
            t: now,
            type: MARKER.CONFLICT,
            title: "Désync person/tracker",
            text: `« ${st.attributes.friendly_name || p} » = home mais aucun de ses ${
              trackers.length
            } trackers n'est home (${states.join(", ")})`,
          });
        } else if (st.state === "not_home" && anyHome) {
          this._flag(`desync:${p}`, p, {
            t: now,
            type: MARKER.CONFLICT,
            title: "Désync person/tracker",
            text: `« ${st.attributes.friendly_name || p} » = not_home mais un tracker est home`,
          });
        }

        // 4. ubiquité : deux zones nommées différentes en même temps
        const zones = [...new Set(states.filter((s) => s !== "not_home" && s !== "unknown" && s !== "unavailable"))];
        if (zones.length > 1) {
          this._flag(`ubiq:${p}`, p, {
            t: now,
            type: MARKER.ERROR,
            title: "Ubiquité",
            text: `Trackers en désaccord sur la zone : ${zones.join(" / ")} — GPS dérivant ou zone mal dimensionnée`,
          });
        }
      }
    }
  }

  _laneSubLabel(l) {
    const st = this._hass?.states?.[l.id]?.state;
    const t = l.counters.transitions;
    return `${st ?? "?"}${t ? ` · ${t} chg` : ""}`;
  }

  _statsHtml(lanes, now) {
    const stateOf = (id) => this._hass?.states?.[id]?.state;
    const persons = (this._entities || []).filter((e) => e.startsWith("person."));
    const home = persons.filter((p) => stateOf(p) === "home").length;
    const motion = (this._entities || []).filter((e) => e.startsWith("binary_sensor.") && stateOf(e) === "on").length;
    let anomalies = 0;
    for (const l of this._core.lanes.values())
      anomalies += l.markers.filter((m) => m.t > now - this.windowMs && m.type !== MARKER.TRIGGER).length;
    return `
      <span class="k-run"><b>${home}</b>/${persons.length} présents</span>
      <span><b>${motion}</b> capteurs actifs</span>
      <span class="k-cfl">⚠ <b>${anomalies}</b> anomalies</span>
      <span>${this._entities?.length || 0} pistes</span>`;
  }

  _tipHtml(h) {
    if (h.marker) {
      return `<div class="t">${h.marker.title}</div><div>${(h.marker.text || "").replace(
        /\n/g,
        "<br>"
      )}</div><div class="d">${fmtClock(h.marker.t)}</div>`;
    }
    if (h.span) {
      const end = h.span.end == null ? this._now() : h.span.end;
      return `<div class="t">${h.lane.label}</div>
        <div>état : <b>${h.span.state}</b> · ${fmtDur(end - h.span.start)}</div>
        <div class="d">${fmtClock(h.span.start)} → ${h.span.end == null ? "…" : fmtClock(h.span.end)}</div>
        <div class="d">${h.lane.id}</div>`;
    }
    return `<div class="t">${h.lane.label}</div><div class="d">${h.lane.id}</div>`;
  }

  static getStubConfig() {
    return { type: "custom:presence-timeline-card", window: 60, auto_discover: true };
  }
}

/* ============================================================
 * 7. Enregistrement
 * ==========================================================*/

if (!customElements.get("automation-timeline-card")) {
  customElements.define("automation-timeline-card", AutomationTimelineCard);
}
if (!customElements.get("presence-timeline-card")) {
  customElements.define("presence-timeline-card", PresenceTimelineCard);
}

window.customCards = window.customCards || [];
window.customCards.push(
  {
    type: "automation-timeline-card",
    name: "Automation Timeline",
    description: "Frise glissante des automatisations : chevauchements, conflits d'entités, erreurs.",
    preview: false,
    documentationURL: "https://github.com/an02H/ha-timeline-cards",
  },
  {
    type: "presence-timeline-card",
    name: "Presence Timeline",
    description: "Frise glissante de la présence : flapping, mouvements fantômes, désync person/tracker.",
    preview: false,
    documentationURL: "https://github.com/an02H/ha-timeline-cards",
  }
);
