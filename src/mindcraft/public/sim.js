// Sim dashboard: renders the cognition / memory / skills / social / economics
// state that full_state.js already publishes. Reads the same `state-update`
// payload the agent cards use; adds a live event feed over `agent-event`.
//
// Charting follows the project's dataviz method: categorical slots 1-3 for
// identity, a blue sequential ramp for magnitude, a blue<->red diverging pair
// for relationship polarity, and the fixed status palette for state. Every
// multi-series view carries a legend, and every mark carries a hover/focus
// readout. Colour never carries meaning on its own.
(function () {
    'use strict';

    const feed = [];
    const MAX_FEED = 200;
    let tv = false;

    // ui.js owns escaping; fall back if this file is ever loaded standalone.
    const esc = window.esc || (v => String(v ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;'));

    // Every type the memory system emits maps to a rail colour and a legend
    // entry. 'belief' was missing, so reflection output — the most interesting
    // thing the agent produces — rendered as an unlabelled grey row.
    const EVENT_KIND = {
        goal_started: 'goal', goal_completed: 'goal', goal_abandoned: 'goal', plan_revised: 'goal',
        code: 'skill',
        social: 'social', gossip: 'social', chat_received: 'social', speech: 'social',
        belief: 'belief',
        death: 'death', damage: 'death',
        session: 'session',
        discovery: 'discovery', place: 'discovery',
    };

    function clock(ts) {
        const d = new Date(ts);
        return [d.getHours(), d.getMinutes(), d.getSeconds()]
            .map(n => String(n).padStart(2, '0')).join(':');
    }

    // label · value · sub. Status class is only ever applied alongside the
    // explanatory sub-line, so the colour never speaks alone.
    function tile(label, value, sub, cls, tip) {
        return `<div class="sim-tile"${tip ? ` data-tip="${esc(tip)}" tabindex="0"` : ''}>`
            + `<div class="label">${esc(label)}</div>`
            + `<div class="value${cls ? ' ' + cls : ''}">${esc(value)}</div>`
            + `<div class="sub">${esc(sub || '')}</div></div>`;
    }

    function legend(items) {
        return '<div class="sim-legend">'
            + items.map(([role, text]) => `<span><i style="background:var(--${role})"></i>${esc(text)}</span>`).join('')
            + '</div>';
    }

    // ---- aggregate tiles across all agents ----
    function renderTiles(states) {
        const agents = Object.values(states).filter(s => s && !s.error);
        if (agents.length === 0) return '';
        let calls = 0, cost = 0, local_num = 0, local_den = 0, events = 0, beliefs = 0, skills = 0, pursuing = 0;
        let cache_read = 0, in_tokens = 0, api_calls = 0;
        for (const s of agents) {
            const e = s.economics;
            if (e) {
                calls += e.per_hour?.calls || 0;
                cost += e.per_hour?.cost || 0;
                local_num += (e.local_share || 0) * (e.totals?.calls || 0);
                local_den += e.totals?.calls || 0;
                cache_read += e.totals?.cache_read_tokens || 0;
                in_tokens += e.totals?.in_tokens || 0;
                api_calls += (e.totals?.calls || 0) - Math.round((e.local_share || 0) * (e.totals?.calls || 0));
            }
            events += s.memory?.events || 0;
            beliefs += s.memory?.beliefs || 0;
            skills += s.skills?.count || 0;
            if (s.cognition?.state === 'pursuing') pursuing++;
        }
        const share = local_den ? local_num / local_den : null;
        // status colour + an explicit target in the sub-line: the 70% bar is
        // the Phase 6 goal, so the reader is told what "good" means.
        const shareCls = share === null ? '' : share >= 0.7 ? 'good' : share >= 0.4 ? 'warning' : 'critical';
        const compact = window.compact || (n => String(n));
        return '<div class="sim-tiles">'
            + tile('Agents', agents.length, `${pursuing} pursuing a goal`)
            + tile('Local calls', share === null ? '—' : Math.round(share * 100) + '%', 'target ≥ 70%', shareCls,
                share === null ? null : `${Math.round(share * 100)}%\trun on local hardware`)
            + tile('Calls / hr', compact(calls), 'all agents combined')
            + tile('Cost / hr', '$' + cost.toFixed(2), '$' + (cost * 24).toFixed(2) + ' per day at this rate')
            + tile('Memories', compact(events), `${compact(beliefs)} beliefs formed`)
            + tile('Skills learned', compact(skills), 'reusable programs')
            + cacheTile(cache_read, in_tokens, api_calls)
            + '</div>';
    }

    // Only meaningful for providers that report real usage (Anthropic does).
    // A 0% reading on a paid model is the signal that the cache breakpoint is
    // not engaging — which is invisible otherwise, because nothing breaks.
    function cacheTile(cache_read, in_tokens, api_calls) {
        if (!api_calls) return '';
        const rate = in_tokens ? cache_read / in_tokens : 0;
        const cls = rate >= 0.5 ? 'good' : rate > 0 ? 'warning' : 'critical';
        return tile('Prompt cache', Math.round(rate * 100) + '%',
            rate > 0 ? 'of input served from cache' : 'not engaging — see measure_prompt.mjs',
            cls,
            `${Math.round(rate * 100)}%\tof input tokens read from cache`);
    }

    function renderDrives(cog) {
        // The drive state exists even when the loop is off; showing meters
        // beside "cognition disabled" just confuses.
        if (!cog?.enabled) return '';
        const drives = cog?.urgencies || [];
        if (drives.length === 0) return '';
        const active = cog?.drive;
        const rows = drives.map(d => {
            const pct = Math.max(0, Math.min(1, d.urgency)) * 100;
            const cls = (d.name === active ? ' active' : '') + (d.on_cooldown ? ' cooldown' : '');
            const tip = `${d.urgency.toFixed(2)}\t${d.name} urgency`
                + (d.name === active ? '\nCurrently driving this agent' : '')
                + (d.on_cooldown ? '\nOn cooldown after a recent failure' : '');
            return `<div class="sim-drive${cls}" data-tip="${esc(tip)}" tabindex="0">`
                + `<span class="name">${esc(d.name)}</span>`
                + `<span class="track"><span class="fill" style="width:${pct.toFixed(1)}%"></span></span>`
                + `<span class="num">${d.urgency.toFixed(2)}</span></div>`;
        }).join('');
        return '<div class="sim-section"><div class="heading"><span>Drives — urgency</span>'
            + '<span style="font-weight:400;letter-spacing:0;text-transform:none;">0 → 1</span></div>'
            + rows + '</div>';
    }

    // The long-horizon thing. Shown above the immediate goal because it is the
    // context that makes the goal make sense: "gather 64 stone" reads very
    // differently when you can see it is milestone 2 of a watchtower.
    function renderProject(cog) {
        const p = cog?.project;
        if (!p) return '';
        const pct = Math.round((p.progress || 0) * 100);
        const bar = '<div class="sim-progress">' + (p.milestones || []).map(m =>
            `<i class="${m.done ? 'done' : ''}" title="${esc(m.text)}"></i>`).join('') + '</div>';
        const short = Object.entries(p.outstanding || {}).slice(0, 4)
            .map(([k, v]) => `${v} ${k}`).join(', ');
        const hrs = (p.active_ms || 0) / 3600000;
        const worked = hrs >= 1 ? `${hrs.toFixed(1)}h` : `${Math.round((p.active_ms || 0) / 60000)}m`;
        return '<div class="sim-section sim-project"><div class="heading">'
            + `<span>Project</span><span>${pct}% · ${esc(worked)} of work`
            + (p.sessions ? ` · ${p.sessions + 1} sessions` : '') + '</span></div>'
            + `<div class="sim-goal">${esc(p.intent)}</div>`
            + bar
            + (p.next ? `<div class="sim-step">Next: ${esc(p.next)}</div>` : '')
            + (short ? `<div class="sim-step">Still needs: ${esc(short)}</div>` : '')
            + '</div>';
    }

    function renderGoal(cog) {
        if (!cog) return '';
        if (cog.state !== 'pursuing') {
            const why = cog.enabled ? 'Content — no drive urgent enough to act on' : 'Cognition disabled';
            return `<div class="sim-section"><div class="heading">Goal</div><div class="sim-step">${esc(why)}</div></div>`;
        }
        const step = cog.step;
        let bar = '';
        if (step && step.total > 0) {
            bar = '<div class="sim-progress" role="img" aria-label="Step '
                + step.index + ' of ' + step.total + '">'
                + Array.from({ length: step.total }, (_, i) =>
                    `<i class="${i + 1 < step.index ? 'done' : i + 1 === step.index ? 'current' : ''}"></i>`).join('')
                + '</div>';
        }
        return '<div class="sim-section"><div class="heading">Goal</div>'
            + `<div class="sim-goal">${esc(cog.goal)} <span class="drive-tag">· ${esc(cog.drive)}</span></div>`
            + (step ? `<div class="sim-step">Step ${step.index} of ${step.total}: ${esc(step.text)}</div>` : '')
            + bar
            + (cog.last_thought ? `<div class="sim-thought">${esc(cog.last_thought)}</div>` : '')
            + '</div>';
    }

    function renderRelationships(social) {
        const rels = (social?.relationships || []).filter(r => Math.abs(r.disposition) >= 0.05);
        if (rels.length === 0) return '';
        rels.sort((a, b) => Math.abs(b.disposition) - Math.abs(a.disposition));
        const rows = rels.slice(0, 6).map(r => {
            const d = Math.max(-1, Math.min(1, r.disposition));
            const w = (Math.abs(d) * 50).toFixed(1);
            const bar = `<span class="bar ${d >= 0 ? 'pos' : 'neg'}" style="width:${w}%"></span>`;
            const grudge = r.grudge > 0.15 ? ` <span class="grudge">grudge ${r.grudge.toFixed(2)}</span>` : '';
            const tip = `${d >= 0 ? '+' : ''}${d.toFixed(2)}\t${r.name}\t${d >= 0 ? 'div-pos' : 'div-neg'}`
                + `\n${d >= 0 ? 'Warm regard' : 'Hostility'}`
                + (r.grudge > 0.15 ? `\nHolding a grudge (${r.grudge.toFixed(2)})` : '');
            return `<div class="sim-rel" data-tip="${esc(tip)}" tabindex="0"><span class="name">${esc(r.name)}</span>`
                + `<span class="axis">${bar}</span>`
                + `<span class="num">${d >= 0 ? '+' : ''}${d.toFixed(2)}${grudge}</span></div>`;
        }).join('');
        return '<div class="sim-section"><div class="heading">Relationships</div>'
            + legend([['div-neg', 'hostile'], ['div-pos', 'warm']])
            + rows + '</div>';
    }

    function renderAgent(name, s) {
        const hue = window.hueFor ? window.hueFor(name) : 210;
        const avatar = `<span class="agent-avatar" style="--h:${hue};width:30px;height:30px;font-size:12px" aria-hidden="true">${esc(String(name).slice(0, 2))}</span>`;
        if (!s || s.error)
            return `<div class="sim-agent"><header>${avatar}<h3>${esc(name)}</h3><span class="state offline">offline</span></header></div>`;
        const cog = s.cognition;
        const state = cog?.state === 'pursuing' ? 'pursuing a goal' : (s.action?.current || 'idle');
        const mem = s.memory, sk = s.skills, ec = s.economics;
        const facts = [
            mem?.enabled ? `${mem.events} memories · ${mem.beliefs} beliefs` : null,
            sk?.enabled ? `${sk.count} skills · ${sk.total_uses} uses` : null,
            ec ? `${Math.round((ec.local_share ?? 0) * 100)}% local · $${(ec.per_hour?.cost ?? 0).toFixed(2)}/hr` : null,
        ].filter(Boolean).join('   ·   ');
        return `<div class="sim-agent"><header>${avatar}<h3>${esc(name)}</h3>`
            + `<span class="state">${esc(state)}</span></header>`
            + renderProject(cog)
            + renderGoal(cog)
            + renderDrives(cog)
            + renderRelationships(s.social)
            + (facts ? `<div class="sim-section"><div class="heading">Systems</div><div class="sim-step">${esc(facts)}</div></div>` : '')
            + '</div>';
    }

    function renderFeed() {
        if (feed.length === 0)
            return '<div class="sim-event"><span class="when"></span><span class="who"></span>'
                + '<span class="what">Nothing yet. The feed is fed by the memory system — enable '
                + '<code>use_memory</code> on an agent to populate it.</span></div>';
        return feed.map(e => {
            // hasOwn: a type of 'constructor'/'toString' would otherwise return
            // an inherited value and stringify into the class attribute
            const kind = Object.hasOwn(EVENT_KIND, e.type) ? EVENT_KIND[e.type] : 'other';
            return `<div class="sim-event k-${kind}" data-tip="${esc(e.type)}\t${esc(e.agent)}">`
                + `<span class="when">${esc(clock(e.ts))}</span>`
                + `<span class="who">${esc(e.agent)}</span>`
                + `<span class="what">${esc(e.content)}</span></div>`;
        }).join('');
    }

    // Replacing the whole body's innerHTML once a second tears down and
    // rebuilds every node, which the browser paints as a visible flash and
    // which also destroys text selection and scroll position. Instead the
    // shell is built once and each section is only rewritten when its HTML has
    // actually changed — drives change constantly, the feed rarely, the legend
    // never.
    const lastHtml = {};
    function paint(id, html) {
        if (lastHtml[id] === html) return;
        const el = document.getElementById(id);
        if (!el) return;
        lastHtml[id] = html;
        // Preserve where the reader was in a scrollable section.
        const scroller = el.querySelector('.sim-feed');
        const scroll = scroller ? scroller.scrollTop : null;
        el.innerHTML = html;
        if (scroll !== null) {
            const next = el.querySelector('.sim-feed');
            if (next) next.scrollTop = scroll;
        }
    }

    function buildShell(body) {
        if (document.getElementById('simTiles')) return;
        for (const k of Object.keys(lastHtml)) delete lastHtml[k];
        body.innerHTML = '<div id="simTiles"></div><div id="simAgents" class="sim-agents"></div>'
            + '<div class="sim-section"><div class="heading">Event feed</div>'
            + '<div id="simLegend"></div><div id="simFeedWrap"></div></div>';
    }

    function render() {
        const root = document.getElementById('sim');
        if (!root || !root.classList.contains('active')) return;
        const states = window.lastStates || {};
        const names = Object.keys(states);
        const body = document.getElementById('simBody');
        if (!body) return;

        if (names.length === 0) {
            const empty = '<div class="sim-empty">'
                + '<h3 style="margin-bottom:6px;">No agents are reporting yet</h3>'
                + '<p style="margin:0;">Start an agent from the Agents tab and its drives, goals and '
                + 'relationships appear here live.</p></div>';
            if (lastHtml.__empty !== empty) {
                body.innerHTML = empty;
                for (const k of Object.keys(lastHtml)) delete lastHtml[k];
                lastHtml.__empty = empty;
            }
            return;
        }
        delete lastHtml.__empty;

        buildShell(body);
        paint('simTiles', renderTiles(states));
        paint('simAgents', names.map(n => renderAgent(n, states[n])).join(''));
        paint('simLegend', legend([['series-1', 'goals'], ['series-2', 'skills'], ['series-3', 'social'],
            ['series-4', 'beliefs'], ['seq-400', 'discoveries'], ['critical', 'deaths'],
            ['warning', 'restarts']]));
        paint('simFeedWrap', `<div class="sim-feed" role="log" aria-live="polite">${renderFeed()}</div>`);
    }

    // A burst of events used to trigger one full innerHTML rebuild each.
    // Coalesce into at most one render per animation frame.
    let queued = false;
    function scheduleRender() {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; render(); });
    }

    window.simRender = scheduleRender;
    // The stream carries the full taxonomy (the run archive needs it), so the
    // feed does its own filtering — it is a human-readable highlight reel, not
    // the archive.
    // 'session' is NOT skipped: an agent process restarting is one of the most
    // important things that can happen on a 24/7 run, and hiding it meant the
    // only signal was the call-rate chart dropping to zero — a restart resets
    // the in-memory meter — which the reader had to notice and interpret.
    const FEED_SKIP = new Set(['narration', 'command', 'damage', 'interruption']);
    window.simPushEvent = function (ev) {
        if (!ev || !ev.content) return;
        if (FEED_SKIP.has(ev.type)) return;
        feed.unshift({ ts: ev.ts || Date.now(), agent: ev.agent || '?', type: ev.type || 'other', content: ev.content });
        if (feed.length > MAX_FEED) feed.length = MAX_FEED;
        scheduleRender();
    };
    window.simSetTv = function (on) {
        tv = on;
        const root = document.getElementById('sim');
        if (root) root.classList.toggle('tv', tv);
        const btn = document.getElementById('tvModeBtn');
        if (btn) btn.textContent = tv ? 'Exit TV mode' : 'TV mode';
        scheduleRender();
    };
    window.simIsTv = () => tv;
})();
