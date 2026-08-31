// Reports tab: research runs and behavioral reports, rendered from the
// mindserver's aggregation of the agent event stream. Same source as
// tools/trace.py --events, so the two agree on the same window.
(function () {
    'use strict';

    const sock = () => window.socket;
    let runsList = [];
    let activeRun = null;
    let report = null;
    let scope = { run: null, world: '', agents: [], buckets: 48 };

    function esc(v) {
        return String(v ?? '')
            .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    }

    const clock = (ts) => ts ? new Date(ts).toLocaleString() : '—';

    // Category -> the same glyphs the live feed uses, so the two read alike.
    const GLYPH = {
        goal: '◆', command: '▲', social: '●', death: '✖', speech: '"',
        narration: '·', belief: '★', combat: '!', session: '⏻',
        interruption: '⤬', discovery: '⚑', other: '·',
    };
    const glyph = (c) => Object.hasOwn(GLYPH, c) ? GLYPH[c] : '·';

    function tile(label, value, sub) {
        return `<div class="sim-tile"><div class="label">${esc(label)}</div>`
            + `<div class="value">${esc(value)}</div><div class="sub">${esc(sub || '')}</div></div>`;
    }

    function renderControls() {
        const opts = runsList.map(r =>
            `<option value="${esc(r.id)}"${r.id === scope.run ? ' selected' : ''}>`
            + `${esc(r.name)} — ${r.event_count} events${r.ended_at ? '' : ' (recording)'}</option>`).join('');
        const worlds = (report?.worlds || []);
        const worldOpts = ['<option value="">all worlds</option>']
            .concat(worlds.map(w => `<option value="${esc(w)}"${w === scope.world ? ' selected' : ''}>${esc(w)}</option>`)).join('');
        const agentOpts = (report?.agents || []).map(a =>
            `<label class="rp-check"><input type="checkbox" value="${esc(a)}"${scope.agents.includes(a) ? ' checked' : ''} onchange="reportsToggleAgent(this.value)"> ${esc(a)}</label>`).join('');

        return '<div class="rp-controls">'
            + `<div class="rp-row"><label>Run</label><select onchange="reportsSelectRun(this.value)">`
            + `<option value="">— select a run —</option>${opts}</select>`
            + (activeRun
                ? '<button class="stop-btn" onclick="reportsStopRun()">Stop recording</button>'
                : '<button class="start-btn" onclick="reportsStartRun()">Start a run</button>')
            + '<button class="neutral-btn" onclick="reportsRefresh()">Refresh</button></div>'
            + `<div class="rp-row"><label>World</label><select onchange="reportsSelectWorld(this.value)">${worldOpts}</select>`
            + `<label>Agents</label><span class="rp-checks">${agentOpts || '<span class="rp-dim">all</span>'}</span></div>`
            + '</div>';
    }

    function renderTimeline(t) {
        if (!t || !t.buckets?.length) return '';
        const max = Math.max(1, ...t.buckets.map(b => Object.values(b).reduce((x, y) => x + y, 0)));
        // one column per bucket; height encodes activity, stacked by category
        const cols = t.buckets.map(b => {
            const total = Object.values(b).reduce((x, y) => x + y, 0);
            const h = Math.round((total / max) * 100);
            const parts = Object.entries(b).sort().map(([cat, n]) =>
                `<i class="rp-seg rp-${esc(cat)}" style="flex:${n}" title="${esc(cat)}: ${n}"></i>`).join('');
            return `<span class="rp-col" style="height:${h}%" title="${total} events">${parts}</span>`;
        }).join('');
        return '<div class="sim-section"><div class="heading">Activity over time</div>'
            + `<div class="rp-timeline">${cols}</div>`
            + `<div class="rp-axis"><span>${esc(clock(t.from))}</span><span>${esc(clock(t.to))}</span></div></div>`;
    }

    function renderAgents(rep) {
        const rows = rep.agents.map(a => {
            const p = rep.per_agent[a];
            const cats = Object.entries(p.by_category).sort((x, y) => y[1] - x[1])
                .map(([c, n]) => `${glyph(c)} ${esc(c)} ${n}`).join('  ');
            const kinds = Object.entries(p.by_command_kind).sort((x, y) => y[1] - x[1])
                .map(([k, n]) => `${esc(k)} ${n}`).join(', ') || '—';
            return `<tr><td>${esc(a)}</td><td class="num">${p.total}</td><td class="num">${p.deaths}</td>`
                + `<td class="num">${p.speech}</td><td class="num">${p.beliefs}</td>`
                + `<td>${cats}</td><td>${esc(kinds)}</td></tr>`;
        }).join('');
        return '<div class="sim-section"><div class="heading">Agents</div>'
            + '<table class="rp-table"><tr><th>agent</th><th class="num">events</th><th class="num">deaths</th>'
            + '<th class="num">said</th><th class="num">beliefs</th><th>by category</th><th>command kinds</th></tr>'
            + rows + '</table></div>';
    }

    function renderMatrix(rep) {
        const names = rep.agents;
        if (names.length === 0) return '';
        const head = names.map(n => `<th>${esc(n)}</th>`).join('');
        const rows = names.map(from => {
            const cells = names.map(to => {
                if (from === to) return '<td class="num rp-dim">—</td>';
                const n = rep.interactions?.[from]?.[to] || 0;
                return `<td class="num${n ? '' : ' rp-dim'}">${n || '·'}</td>`;
            }).join('');
            return `<tr><td>${esc(from)}</td>${cells}</tr>`;
        }).join('');
        return '<div class="sim-section"><div class="heading">Who addressed whom</div>'
            + `<table class="rp-table"><tr><th></th>${head}</tr>${rows}</table></div>`;
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
            + 'A server log cannot produce this view — the beliefs only exist in the agent.</p>'
            + (blocks || '<p class="rp-dim">No agents in scope.</p>') + '</div>';
    }

    function renderResources(rep) {
        const rows = Object.entries(rep.resources || {}).flatMap(([agent, items]) =>
            Object.entries(items).sort((a, b) => b[1] - a[1]).slice(0, 8)
                .map(([key, qty]) => `<tr><td>${esc(agent)}</td><td>${esc(key)}</td><td class="num">${qty}</td></tr>`)).join('');
        if (!rows) return '';
        return '<div class="sim-section"><div class="heading">Resource flow</div>'
            + `<table class="rp-table"><tr><th>agent</th><th>action:item</th><th class="num">qty</th></tr>${rows}</table></div>`;
    }

    function render() {
        const root = document.getElementById('reports');
        if (!root || !root.classList.contains('active')) return;
        const body = document.getElementById('reportsBody');
        if (!body) return;
        let html = renderControls();
        if (!report) {
            html += '<div class="sim-empty">Select a run, or start one to begin recording. '
                + 'Runs capture the agent event stream so experiments are comparable.</div>';
        } else if (report.totals.events === 0) {
            html += '<div class="sim-empty">No events in scope yet. Events need <code>use_memory</code> enabled '
                + 'on the agents; notable ones then stream into the active run.</div>';
        } else {
            const t = report.totals;
            html += '<div class="sim-tiles">'
                + tile('Events', t.events, `${report.span.hours}h observed`)
                + tile('Agents', t.agents, `${t.worlds} world${t.worlds === 1 ? '' : 's'}`)
                + tile('Deliberate speech', t.speech, `${t.narration} auto-narrations excluded`)
                + tile('Deaths', t.deaths, '')
                + tile('Beliefs', t.beliefs, 'formed by reflection')
                + '</div>'
                + renderTimeline(report.timeline)
                + renderAgents(report)
                + renderMatrix(report)
                + renderResources(report)
                + renderBeliefs(report);
            if (report._export_path)
                html += `<p class="rp-note">Offline analysis: <code>python3 tools/trace.py --events ${esc(report._export_path)} --html report.html</code></p>`;
        }
        body.innerHTML = html;
    }

    function fetchReport() {
        if (!sock()) return;
        sock().emit('get-report', { ...scope }, (res) => {
            if (res?.success) {
                report = res.report;
                report._export_path = res.export_path;
            } else {
                report = null;
                console.error('Report failed:', res?.error);
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
        sock().emit('start-run', name, () => { scope.run = null; fetchRuns(fetchReport); });
    };
    window.reportsStopRun = function () {
        sock().emit('stop-run', () => fetchRuns(fetchReport));
    };
    window.reportsRender = render;
    window.reportsOnShow = function () { fetchRuns(fetchReport); };
})();
