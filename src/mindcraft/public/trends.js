/* ============================================================================
   Sim → Trends: live call-rate and cost-rate over time, one line per agent.

   Design notes, because several of these are deliberate and easy to "fix" wrongly:

   · TWO charts, never one with two y-axes. Calls/hr and cost/hr have unrelated
     scales; a dual-axis chart lets you imply any correlation you like by
     choosing the scales. They share one time axis instead.
   · Series colour comes from the validated categorical slots, assigned on FIRST
     SIGHT and remembered (localStorage). Colour follows the agent, so adding a
     third agent never repaints the first two. Slots run out at 5 — further
     agents fold to one muted "other" rather than inventing a hue.
   · This module owns its own DOM. sim.js rebuilds its body wholesale on every
     state update, which would destroy the crosshair under the reader's cursor
     once a second.
   · The tooltip enhances and never gates: every value it shows is also on the
     axis, the end labels, or the stat tiles above.
   ========================================================================= */
(function () {
    'use strict';

    const esc = window.esc || (v => String(v ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;'));

    const SAMPLE_MS = 5000;      // state-update is 1Hz; 5s is plenty for a trend
    const MAX_SAMPLES = 360;     // 30 minutes
    const SLOTS = ['series-1', 'series-2', 'series-3', 'series-4', 'series-5'];
    const OVERFLOW_SLOT = 'text-muted';

    const samples = [];          // [{ t, values: { agent: {calls, cost} } }]
    let last_sample = 0;
    let slots = {};              // agent -> slot index, stable for the life of the agent
    let hover = null;            // sample index under the pointer, or null

    try { slots = JSON.parse(localStorage.getItem('mindcraft.agentSlots') || '{}'); }
    catch { slots = {}; }

    function slotFor(agent) {
        if (!Object.hasOwn(slots, agent)) {
            const used = new Set(Object.values(slots));
            let i = 0;
            while (used.has(i) && i < SLOTS.length) i++;
            slots[agent] = i;
            try { localStorage.setItem('mindcraft.agentSlots', JSON.stringify(slots)); } catch { /* private mode */ }
        }
        const i = slots[agent];
        return i < SLOTS.length ? SLOTS[i] : OVERFLOW_SLOT;
    }

    // ---- data ----
    window.trendsSample = function (states) {
        const now = Date.now();
        if (now - last_sample < SAMPLE_MS) return;
        last_sample = now;
        const values = {};
        let any = false;
        for (const [name, s] of Object.entries(states || {})) {
            const e = s && !s.error ? s.economics : null;
            if (!e?.per_hour) continue;
            values[name] = { calls: e.per_hour.calls || 0, cost: e.per_hour.cost || 0 };
            any = true;
        }
        if (!any) return;
        samples.push({ t: now, values });
        if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
        render();
    };

    // ---- scales & ticks ----
    // Round a maximum up to a clean number so the axis reads 0 / 250 / 500,
    // never 0 / 237 / 474.
    function niceMax(v) {
        if (v <= 0) return 1;
        const mag = Math.pow(10, Math.floor(Math.log10(v)));
        const n = v / mag;
        const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
        return step * mag;
    }
    const fmtCalls = (v) => (window.compact ? window.compact(Math.round(v)) : String(Math.round(v)));
    const fmtCost = (v) => '$' + (v < 1 ? v.toFixed(3) : v.toFixed(2));

    // ---- one chart ----
    function chart(key, title, unit, fmt, width) {
        const M = { top: 12, right: 74, bottom: 22, left: 52 };
        const H = 168;
        const W = Math.max(320, width);
        const iw = W - M.left - M.right;
        const ih = H - M.top - M.bottom;

        const agents = [...new Set(samples.flatMap(s => Object.keys(s.values)))].sort();
        const t0 = samples[0].t, t1 = samples[samples.length - 1].t;
        const span = Math.max(1, t1 - t0);
        const rawMax = Math.max(...samples.flatMap(s => Object.values(s.values).map(v => v[key] || 0)), 0);
        const yMax = niceMax(rawMax * 1.15);

        const x = (t) => M.left + ((t - t0) / span) * iw;
        const y = (v) => M.top + ih - (Math.max(0, v) / yMax) * ih;

        // gridlines + y ticks, hairline and recessive
        let grid = '';
        for (let i = 0; i <= 3; i++) {
            const v = (yMax / 3) * i;
            const yy = y(v);
            grid += `<line class="tr-grid" x1="${M.left}" y1="${yy}" x2="${M.left + iw}" y2="${yy}"/>`
                + `<text class="tr-tick" x="${M.left - 8}" y="${yy + 4}" text-anchor="end">${esc(fmt(v))}</text>`;
        }

        // one 2px path per agent, plus an end dot with a surface ring
        let lines = '', dots = '', endLabels = '';
        for (const a of agents) {
            const role = slotFor(a);
            let d = '', open = false, lastPt = null;
            for (const s of samples) {
                const v = s.values[a]?.[key];
                if (v === undefined || v === null) { open = false; continue; }
                const px = x(s.t), py = y(v);
                d += (open ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1) + ' ';
                open = true;
                lastPt = { px, py, v };
            }
            if (!d) continue;
            lines += `<path class="tr-line" d="${d.trim()}" style="stroke:var(--${role})"/>`;
            if (lastPt) {
                dots += `<circle class="tr-dot" cx="${lastPt.px.toFixed(1)}" cy="${lastPt.py.toFixed(1)}" r="4" style="fill:var(--${role})"/>`;
                // direct label at the line end — sparing, and only where it fits
                if (agents.length <= 4)
                    endLabels += `<text class="tr-endlabel" x="${(lastPt.px + 10).toFixed(1)}" y="${(lastPt.py + 4).toFixed(1)}">${esc(a)}</text>`;
            }
        }

        // crosshair snapped to the hovered sample
        let cross = '';
        if (hover !== null && samples[hover]) {
            const px = x(samples[hover].t);
            cross = `<line class="tr-cross" x1="${px}" y1="${M.top}" x2="${px}" y2="${M.top + ih}"/>`;
        }

        const axis = `<line class="tr-axis" x1="${M.left}" y1="${M.top + ih}" x2="${M.left + iw}" y2="${M.top + ih}"/>`;
        const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const xLabels = `<text class="tr-tick" x="${M.left}" y="${H - 5}">${esc(clock(t0))}</text>`
            + `<text class="tr-tick" x="${M.left + iw}" y="${H - 5}" text-anchor="end">${esc(clock(t1))}</text>`;

        return `<div class="tr-chart">
            <div class="tr-head"><span>${esc(title)}</span><span class="tr-unit">${esc(unit)}</span></div>
            <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img"
                 aria-label="${esc(title)} per agent over time"
                 data-chart="${esc(key)}" data-left="${M.left}" data-iw="${iw}">
                ${grid}${axis}${cross}${lines}${dots}${endLabels}${xLabels}
            </svg>
        </div>`;
    }

    function legend(agents) {
        // A single series needs no legend — the title already names it.
        if (agents.length < 2) return '';
        return '<div class="sim-legend">' + agents.map(a =>
            `<span><i style="background:var(--${slotFor(a)})"></i>${esc(a)}</span>`).join('') + '</div>';
    }

    function render() {
        const host = document.getElementById('simTrends');
        const root = document.getElementById('sim');
        if (!host || !root || !root.classList.contains('active')) return;

        if (samples.length < 2) {
            host.innerHTML = '<div class="sim-section"><div class="heading">Trends</div>'
                + '<div class="sim-step">Collecting… the first points appear a few seconds apart.</div></div>';
            return;
        }
        const agents = [...new Set(samples.flatMap(s => Object.keys(s.values)))].sort();
        const width = host.clientWidth || 900;
        host.innerHTML = '<div class="sim-section"><div class="heading">'
            + '<span>Trends — last ' + Math.round((samples[samples.length - 1].t - samples[0].t) / 60000) + ' min</span>'
            + '<span style="font-weight:400;letter-spacing:0;text-transform:none;">one line per agent</span></div>'
            + legend(agents)
            + '<div class="tr-grid-wrap">'
            + chart('calls', 'Calls / hr', 'rolling rate', fmtCalls, width - 40)
            + chart('cost', 'Cost / hr', 'USD, rolling rate', fmtCost, width - 40)
            + '</div></div>';
    }

    // ---- crosshair + readout ----
    let tipEl = null;
    function tip() {
        if (!tipEl) {
            tipEl = document.createElement('div');
            tipEl.className = 'tip';
            document.body.appendChild(tipEl);
        }
        return tipEl;
    }
    function hideTip() { if (tipEl) tipEl.classList.remove('show'); }

    function onMove(e) {
        const svg = e.target.closest?.('#simTrends svg');
        if (!svg) { if (hover !== null) { hover = null; render(); } hideTip(); return; }
        const rect = svg.getBoundingClientRect();
        const left = Number(svg.dataset.left), iw = Number(svg.dataset.iw);
        const vbWidth = svg.viewBox.baseVal.width || rect.width;
        const scale = rect.width / vbWidth;
        const px = (e.clientX - rect.left) / scale;
        const frac = Math.max(0, Math.min(1, (px - left) / iw));
        // readers aim at a time, never at a 2px line: snap to the nearest sample
        const idx = Math.round(frac * (samples.length - 1));
        if (idx !== hover) { hover = idx; render(); }

        const s = samples[hover];
        if (!s) return;
        const el = tip();
        el.textContent = '';
        const when = document.createElement('div');
        when.className = 'tip-row';
        when.textContent = new Date(s.t).toLocaleTimeString();
        el.appendChild(when);
        // every series at this x, values leading
        for (const [a, v] of Object.entries(s.values)) {
            const row = document.createElement('div');
            row.className = 'tip-row';
            const key = document.createElement('span');
            key.className = 'tip-key';
            key.style.background = `var(--${slotFor(a)})`;
            const k = document.createElement('span');
            k.className = 'tip-k';
            k.textContent = a;                                  // untrusted
            const val = document.createElement('span');
            val.className = 'tip-v';
            val.textContent = `${fmtCalls(v.calls)} calls/hr · ${fmtCost(v.cost)}/hr`;
            row.append(key, k, val);
            el.appendChild(row);
        }
        el.classList.add('show');
        const r = el.getBoundingClientRect();
        let lx = e.clientX + 14, ly = e.clientY + 14;
        if (lx + r.width > window.innerWidth - 8) lx = e.clientX - r.width - 14;
        if (ly + r.height > window.innerHeight - 8) ly = e.clientY - r.height - 14;
        el.style.left = Math.max(8, lx) + 'px';
        el.style.top = Math.max(8, ly) + 'px';
    }

    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', () => { hover = null; hideTip(); render(); }, { passive: true });
    window.addEventListener('resize', () => render());

    window.trendsRender = render;
})();
