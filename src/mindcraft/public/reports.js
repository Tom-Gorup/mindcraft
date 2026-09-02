// Reports tab: research runs and behavioural reports, rendered from the
// mindserver's aggregation of the agent event stream. Same source as
// tools/trace.py --events, so the two agree on the same window.
//
// Charts follow the project's dataviz method: the activity chart is a stacked
// column chart (categorical slots in fixed order, 2px surface gaps doing the
// separating, 4px rounded data-end square at the baseline), the interaction
// matrix is a heat grid on the one-hue sequential ramp, and every mark carries
// its own hover/focus readout. Nothing is reachable only by hovering — the
// tables below carry the same numbers.
(function () {
    'use strict';

    const sock = () => window.socket;
    let runsList = [];
    let activeRun = null;
    let report = null;
    let scope = { run: null, world: '', agents: [], buckets: 48 };
    let controlsKey = '';      // rebuild the filter row only when it changes

    const esc = window.esc || (v => String(v ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;'));

    const clock = (ts) => ts ? new Date(ts).toLocaleString() : '—';
    const shortClock = (ts) => ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

    // Category -> the same glyphs the live feed uses, so the two read alike.
    const GLYPH = {
        goal: '◆', command: '▲', social: '●', death: '✖', speech: '"',
        narration: '·', belief: '★', combat: '!', session: '⏻',
        interruption: '⤬', discovery: '⚑', other: '·',
    };
    const glyph = (c) => Object.hasOwn(GLYPH, c) ? GLYPH[c] : '·';

    // Fixed categorical assignment AND fixed stacking order — the two have to
    // be decided together, because a stack's colour gates are measured on
    // *adjacent* pairs. Stacking alphabetically previously put belief beside
    // command, and gave social and speech the same hue back to back.
    //
    // This order (slots 1,2,3,4,5 then muted then status) validates in both
    // modes: worst adjacent CVD ΔE 8.4 dark / 9.1 light, worst adjacent
    // normal-vision ΔE 19.3 dark / 19.6 light, all >= 3:1 on the dark surface.
    // Light mode has three slots under 3:1, where the relief rule applies and
    // is satisfied — every series is named in the legend and every number is
    // repeated in the Agents table below.
    //
    // Everything unnamed folds into one muted "other" rather than generating a
    // hue: a sixth behavioural category is never a new colour.
    const CAT_ORDER = ['goal', 'command', 'social', 'belief', 'speech', 'narration', 'death'];
    const CAT_ROLE = {
        goal: 'series-1', command: 'series-2', social: 'series-3',
        belief: 'series-4', speech: 'series-5', death: 'critical',
    };
    const roleFor = (c) => Object.hasOwn(CAT_ROLE, c) ? CAT_ROLE[c] : 'text-muted';
    // stack position: named categories in slot order, everything else after
    const catRank = (c) => { const i = CAT_ORDER.indexOf(c); return i === -1 ? CAT_ORDER.length : i; };
    const byCat = (a, b) => catRank(a) - catRank(b) || String(a).localeCompare(String(b));

    function tile(label, value, sub) {
        return `<div class="sim-tile"><div class="label">${esc(label)}</div>`
            + `<div class="value">${esc(value)}</div><div class="sub">${esc(sub || '')}</div></div>`;
    }

    function renderControls() {
        const opts = runsList.map(r =>
            `<option value="${esc(r.id)}"${r.id === scope.run ? ' selected' : ''}>`
            + `${esc(r.name)} — ${r.event_count} events${r.ended_at ? '' : ' (recording)'}${r.interrupted ? ' (interrupted)' : ''}</option>`).join('');
        const worlds = (report?.worlds || []);
        const worldOpts = ['<option value="">All worlds</option>']
            .concat(worlds.map(w => `<option value="${esc(w)}"${w === scope.world ? ' selected' : ''}>${esc(w)}</option>`)).join('');
        const agentOpts = (report?.agents || []).map(a =>
            `<label class="rp-check"><input type="checkbox" value="${esc(a)}"${scope.agents.includes(a) ? ' checked' : ''} onchange="reportsToggleAgent(this.value)"> ${esc(a)}</label>`).join('');

        // Filters live in one row above everything they scope.
        return '<div class="rp-controls">'
            + '<div class="rp-row">'
            + '<label for="rpRun">Run</label>'
            + `<select id="rpRun" onchange="reportsSelectRun(this.value)"><option value="">— select a run —</option>${opts}</select>`
            + (activeRun ? '<span class="rec-pill">recording</span>' : '')
            + '<span class="spacer"></span>'
            + (activeRun
                ? '<button class="stop-btn" onclick="reportsStopRun()">Stop recording</button>'
                : '<button class="start-btn" onclick="reportsStartRun()">Start a run</button>')
            + '<button class="neutral-btn" onclick="reportsRefresh()">Refresh</button>'
            // Plain anchors: the browser downloads them directly, and they keep
            // working if the socket has dropped.
            + (scope.run
                ? `<a class="neutral-btn" download href="/run/${encodeURIComponent(scope.run)}/report.json"`
                  + ' data-tip="A self-contained JSON bundle: totals, per-agent breakdown, why goals ended, and every belief in full.">Download report</a>'
                  + `<a class="neutral-btn" download href="/run/${encodeURIComponent(scope.run)}/events.jsonl"`
                  + ' data-tip="The raw event stream — every event, unaggregated. Feeds tools/trace.py.">Download events</a>'
                : '')
            + '</div>'
            + '<div class="rp-row">'
            + '<label for="rpWorld">World</label>'
            + `<select id="rpWorld" onchange="reportsSelectWorld(this.value)">${worldOpts}</select>`
            + '<label>Agents</label>'
            + `<span class="rp-checks">${agentOpts || '<span class="rp-dim">all</span>'}</span>`
            + '</div></div>';
    }

    // ---- activity over time: stacked columns ----
    function renderTimeline(t) {
        if (!t || !t.buckets?.length) return '';
        const totals = t.buckets.map(b => Object.values(b).reduce((x, y) => x + y, 0));
        const max = Math.max(1, ...totals);
        // every category present anywhere, so the legend is stable across
        // buckets and colour assignment never shifts between renders
        const cats = [...new Set(t.buckets.flatMap(b => Object.keys(b)))].sort(byCat);

        const cols = t.buckets.map((b, i) => {
            const total = totals[i];
            const h = total === 0 ? 2 : Math.max(3, Math.round((total / max) * 100));
            if (total === 0)
                return `<span class="rp-col is-empty" style="height:2px" data-tip="No events" tabindex="0"></span>`;
            const parts = Object.entries(b).sort((x, y) => byCat(x[0], y[0])).map(([cat, n]) =>
                `<i class="rp-seg" style="flex:${n};background:var(--${roleFor(cat)})"></i>`).join('');
            // one readout listing every series in this column, values leading
            const tip = `${total}\tevents in this bucket\n`
                + Object.entries(b).sort((x, y) => y[1] - x[1])
                    .map(([cat, n]) => `${n}\t${cat}\t${roleFor(cat)}`).join('\n');
            return `<span class="rp-col" style="height:${h}%" data-tip="${esc(tip)}" tabindex="0">${parts}</span>`;
        }).join('');

        return '<div class="sim-section"><div class="heading">'
            + `<span>Activity over time</span><span style="font-weight:400;letter-spacing:0;text-transform:none;">${t.buckets.length} buckets · peak ${max}</span></div>`
            + '<div class="sim-legend">'
            + cats.map(c => `<span><i style="background:var(--${roleFor(c)})"></i>${esc(c)}</span>`).join('')
            + '</div>'
            + `<div class="rp-chart"><div class="rp-timeline">${cols}</div>`
            + `<div class="rp-axis"><span>${esc(shortClock(t.from))}</span><span>${esc(shortClock(t.to))}</span></div></div></div>`;
    }

    function renderAgents(rep) {
        const rows = rep.agents.map(a => {
            const p = rep.per_agent[a];
            const cats = Object.entries(p.by_category).sort((x, y) => y[1] - x[1])
                .map(([c, n]) => `${glyph(c)} ${esc(c)} ${n}`).join('   ');
            const kinds = Object.entries(p.by_command_kind).sort((x, y) => y[1] - x[1])
                .map(([k, n]) => `${esc(k)} ${n}`).join(', ') || '—';
            return `<tr><td>${esc(a)}</td><td class="num">${p.total}</td><td class="num">${p.deaths}</td>`
                + `<td class="num">${p.speech}</td><td class="num">${p.beliefs}</td>`
                + `<td>${cats}</td><td>${esc(kinds)}</td></tr>`;
        }).join('');
        return '<div class="sim-section"><div class="heading">Agents</div><div class="rp-table-wrap">'
            + '<table class="rp-table"><thead><tr><th>agent</th><th class="num">events</th><th class="num">deaths</th>'
            + '<th class="num">said</th><th class="num">beliefs</th><th>by category</th><th>command kinds</th></tr></thead>'
            + `<tbody>${rows}</tbody></table></div></div>`;
    }

    // ---- who addressed whom: a heat grid on the one-hue sequential ramp ----
    function renderMatrix(rep) {
        const names = rep.agents;
        if (names.length === 0) return '';
        let max = 0;
        for (const from of names)
            for (const to of names)
                if (from !== to) max = Math.max(max, rep.interactions?.[from]?.[to] || 0);

        const head = names.map(n => `<th class="num">${esc(n)}</th>`).join('');
        const rows = names.map(from => {
            const cells = names.map(to => {
                if (from === to) return '<td class="cell diag">—</td>';
                const n = rep.interactions?.[from]?.[to] || 0;
                if (!n) return '<td class="cell rp-dim">·</td>';
                // five discrete steps of the blue ramp; the count is printed
                // in the cell, so the colour is reinforcement, not the message
                const step = max <= 1 ? 4 : Math.min(4, Math.floor((n / max) * 4.999));
                const ramp = ['seq-100', 'seq-250', 'seq-400', 'seq-550', 'seq-700'][step];
                return `<td class="cell" style="background:var(--${ramp});color:var(--${ramp}-ink)"`
                    + ` data-tip="${esc(n)}\t${esc(from)} → ${esc(to)}" tabindex="0">${n}</td>`;
            }).join('');
            return `<tr><td>${esc(from)}</td>${cells}</tr>`;
        }).join('');
        return '<div class="sim-section"><div class="heading"><span>Who addressed whom</span>'
            + `<span style="font-weight:400;letter-spacing:0;text-transform:none;">row → column · darkest = ${max}</span></div>`
            + '<div class="rp-table-wrap"><table class="rp-table rp-matrix">'
            + `<thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
    }

    function renderBeliefs(rep) {
        const blocks = Object.entries(rep.believed_vs_observed || {}).map(([agent, rec]) => {
            const beliefs = rec.beliefs.length
                ? rec.beliefs.slice(-5).map(b => `<li>${esc(b.content)}</li>`).join('')
                : '<li class="rp-dim">no beliefs formed yet</li>';
            return `<div class="rp-belief"><div class="rp-belief-head">${esc(agent)}`
                + ` <span class="rp-dim">observed ${rec.observed} events · `
                + `${rec.goals_completed} goals completed, ${rec.goals_abandoned} abandoned, ${rec.deaths} deaths</span></div>`
                + `<ul>${beliefs}</ul></div>`;
        }).join('');
        return '<div class="sim-section"><div class="heading">Believed vs observed</div>'
            + '<p class="rp-note">What each agent concluded, beside what actually happened to it. '
            + 'A server log cannot produce this view — the beliefs only exist inside the agent.</p>'
            + (blocks || '<p class="rp-dim">No agents in scope.</p>') + '</div>';
    }

    // Why goals ended.
    //
    // "94% abandoned" is a fact about the run; the reasons are the fact about
    // the design. Preemption is separated from failure because they have
    // different fixes: preemption means the arbiter is thrashing, failure means
    // execution is losing.
    function renderGoals(rep) {
        const entries = Object.entries(rep.goal_outcomes || {});
        if (!entries.length) return '';
        const blocks = entries.map(([agent, rec]) => {
            const attempted = rec.completed + rec.abandoned;
            if (!attempted) return '';
            const pct = Math.round(rec.completion_rate * 100);
            const reasons = Object.entries(rec.by_reason).sort((a, b) => b[1] - a[1]);
            const worst = reasons.length ? reasons[0][1] : 1;
            const rows = reasons.map(([reason, n]) =>
                '<tr><td>' + esc(reason) + '</td><td class="num">' + n + '</td>'
                + '<td class="rp-barcell"><span class="rp-bar" style="width:'
                + Math.round((n / worst) * 100) + '%"></span></td></tr>').join('');
            const preempt = Object.entries(rec.preemptions).flatMap(([drive, by]) =>
                Object.entries(by).map(([winner, n]) =>
                    esc(winner) + ' interrupted ' + esc(drive) + ' &times;' + n));
            return '<div class="rp-goal-block">'
                + '<div class="rp-goal-head"><strong>' + esc(agent) + '</strong>'
                + '<span class="rp-dim">' + rec.completed + ' completed &middot; '
                + rec.abandoned + ' abandoned &middot; ' + pct + '% completion</span></div>'
                + '<div class="rp-table-wrap"><table class="rp-table">'
                + '<thead><tr><th>why it ended</th><th class="num">n</th><th></th></tr></thead>'
                + '<tbody>' + rows + '</tbody></table></div>'
                + (preempt.length ? '<p class="rp-note">' + preempt.join(' &middot; ') + '</p>' : '')
                + '</div>';
        }).join('');
        if (!blocks) return '';
        return '<div class="sim-section"><div class="heading">Why goals ended</div>'
            + '<div class="rp-goals">' + blocks + '</div></div>';
    }

    // Long work. Milestones completed is the honest measure; attempts on an
    // unfinished milestone is the warning.
    function renderProjects(rep) {
        const entries = Object.entries(rep.project_outcomes || {}).filter(
            ([, r]) => r.started || r.milestone_attempts);
        if (!entries.length) return '';
        const blocks = entries.map(([agent, r]) => {
            const rows = (r.projects || []).map(p =>
                '<tr><td>' + esc(p.intent || '—') + '</td><td>' + esc(p.status)
                + (p.minutes != null ? ' (' + p.minutes + ' min)' : '') + '</td></tr>').join('');
            const stalled = (r.stalled || []).map(sm =>
                '<li><span class="rp-stall">&times;' + sm.attempts + '</span> '
                + esc(sm.milestone) + '</li>').join('');
            return '<div class="rp-goal-block">'
                + '<div class="rp-goal-head"><strong>' + esc(agent) + '</strong>'
                + '<span class="rp-dim">' + r.milestones_completed + ' of '
                + r.milestone_attempts + ' milestone attempts finished</span></div>'
                + (rows ? '<div class="rp-table-wrap"><table class="rp-table">'
                    + '<thead><tr><th>project</th><th>status</th></tr></thead>'
                    + '<tbody>' + rows + '</tbody></table></div>' : '')
                + (stalled ? '<p class="rp-note">Retried without finishing:</p>'
                    + '<ul class="rp-stalls">' + stalled + '</ul>' : '')
                + '</div>';
        }).join('');
        return '<div class="sim-section"><div class="heading">Long work</div>'
            + '<div class="rp-goals">' + blocks + '</div></div>';
    }

    function renderResources(rep) {
        const rows = Object.entries(rep.resources || {}).flatMap(([agent, items]) =>
            Object.entries(items).sort((a, b) => b[1] - a[1]).slice(0, 8)
                .map(([key, qty]) => `<tr><td>${esc(agent)}</td><td>${esc(key)}</td><td class="num">${qty}</td></tr>`)).join('');
        if (!rows) return '';
        return '<div class="sim-section"><div class="heading">Resource flow</div><div class="rp-table-wrap">'
            + '<table class="rp-table"><thead><tr><th>agent</th><th>action:item</th><th class="num">qty</th></tr></thead>'
            + `<tbody>${rows}</tbody></table></div></div>`;
    }

    function renderBody() {
        if (!report) {
            return '<div class="sim-empty">'
                + '<h3 style="margin:0 0 6px;">No run selected</h3>'
                + '<p style="margin:0;">Pick a run above, or start one to begin recording. Runs capture the '
                + 'agent event stream so two experiments can be compared side by side.</p></div>';
        }
        if (report.totals.events === 0) {
            return '<div class="sim-empty">'
                + '<h3 style="margin:0 0 6px;">No events in scope</h3>'
                + '<p style="margin:0;">Events require <code>use_memory</code> on the agents; notable ones '
                + 'then stream into the active run.</p></div>';
        }
        const t = report.totals;
        const compact = window.compact || (n => String(n));
        let html = '<div class="sim-tiles">'
            + tile('Events', compact(t.events), `${report.span.hours}h observed`)
            + tile('Agents', t.agents, `${t.worlds} world${t.worlds === 1 ? '' : 's'}`)
            + tile('Deliberate speech', compact(t.speech), `${compact(t.narration)} auto-narrations excluded`)
            + tile('Deaths', t.deaths, t.deaths ? 'across all agents' : 'none yet')
            + tile('Beliefs', compact(t.beliefs), 'formed by reflection')
            + '</div>'
            + renderTimeline(report.timeline)
            + renderAgents(report)
            + renderMatrix(report)
            + renderGoals(report)
            + renderProjects(report)
            + renderResources(report)
            + renderBeliefs(report);
        if (report._export_path)
            html += `<p class="rp-note">Offline analysis: <code>python3 tools/trace.py --events ${esc(report._export_path)} --html report.html</code></p>`;
        return html;
    }

    function render() {
        const root = document.getElementById('reports');
        if (!root || !root.classList.contains('active')) return;
        const body = document.getElementById('reportsBody');
        if (!body) return;

        // Rebuild the filter row only when its contents actually change —
        // otherwise every refetch would blow away focus and the open state of
        // the select the reader is using.
        const key = JSON.stringify([runsList.map(r => [r.id, r.event_count, r.ended_at]), activeRun,
            report?.worlds, report?.agents, scope]);
        if (!document.getElementById('rpControlsHost')) {
            body.innerHTML = '<div id="rpControlsHost"></div><div id="rpBody"></div>';
            controlsKey = '';
        }
        if (key !== controlsKey) {
            document.getElementById('rpControlsHost').innerHTML = renderControls();
            controlsKey = key;
        }
        const target = document.getElementById('rpBody');
        target.classList.remove('is-refetching');
        target.innerHTML = renderBody();
    }

    function fetchReport() {
        if (!sock()) return;
        // Refetch keeps the frame: hold the previous render at reduced opacity
        // rather than flashing a skeleton and jumping the layout.
        document.getElementById('rpBody')?.classList.add('is-refetching');
        sock().emit('get-report', { ...scope }, (res) => {
            if (res?.success) {
                report = res.report;
                report._export_path = res.export_path;
            } else {
                report = null;
                console.error('Report failed:', res?.error);
                window.toast?.('Report failed', res?.error || 'The mindserver could not build the report.', 'critical');
            }
            render();
        });
    }

    function fetchRuns(then) {
        if (!sock()) return;
        sock().emit('list-runs', (res) => {
            runsList = res?.runs || [];
            activeRun = res?.active || null;
            if (!scope.run && activeRun) scope.run = activeRun;
            if (then) then();
            render();
        });
    }

    window.reportsRefresh = function () { fetchRuns(fetchReport); };
    window.reportsSelectRun = function (id) { scope.run = id || null; scope.agents = []; fetchReport(); };
    window.reportsSelectWorld = function (w) { scope.world = w || ''; fetchReport(); };
    window.reportsToggleAgent = function (a) {
        scope.agents = scope.agents.includes(a) ? scope.agents.filter(x => x !== a) : [...scope.agents, a];
        fetchReport();
    };
    window.reportsStartRun = function () {
        const name = prompt('Name this run (e.g. "wilbur vs greta, 3h")', 'run');
        if (name === null) return;
        sock().emit('start-run', name, (res) => {
            if (res?.success) window.toast?.('Recording started', res.run?.name, 'good');
            else window.toast?.('Could not start the run', res?.error || '', 'critical');
            scope.run = null;
            fetchRuns(fetchReport);
        });
    };
    window.reportsStopRun = function () {
        sock().emit('stop-run', (res) => {
            if (res?.run) window.toast?.('Recording stopped', `${res.run.name} — ${res.run.event_count} events`, 'good');
            fetchRuns(fetchReport);
        });
    };
    window.reportsRender = render;
    window.reportsOnShow = function () { fetchRuns(fetchReport); };
})();
