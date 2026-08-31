// Sim dashboard: renders the cognition / memory / skills / social / economics
// state that full_state.js already publishes. Reads the same `state-update`
// payload the agent cards use; adds a live event feed over `agent-event`.
(function () {
    'use strict';

    const feed = [];
    const MAX_FEED = 200;
    let tv = false;

    // Untrusted: agent names and event text originate in Minecraft chat.
    function esc(v) {
        return String(v ?? '')
            .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    }

    const EVENT_KIND = {
        goal_started: 'goal', goal_completed: 'goal', goal_abandoned: 'goal', plan_revised: 'goal',
        code: 'skill',
        social: 'social', gossip: 'social', chat_received: 'social', speech: 'social',
        death: 'death',
    };

    function clock(ts) {
        const d = new Date(ts);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
    }

    function tile(label, value, sub, cls) {
        return `<div class="sim-tile"><div class="label">${esc(label)}</div>`
            + `<div class="value${cls ? ' ' + cls : ''}">${esc(value)}</div>`
            + `<div class="sub">${esc(sub || '')}</div></div>`;
    }

    // ---- aggregate tiles across all agents ----
    function renderTiles(states) {
        const agents = Object.values(states).filter(s => s && !s.error);
        if (agents.length === 0) return '';
        let calls = 0, cost = 0, local_num = 0, local_den = 0, events = 0, beliefs = 0, skills = 0, pursuing = 0;
        for (const s of agents) {
            const e = s.economics;
            if (e) {
                calls += e.per_hour?.calls || 0;
                cost += e.per_hour?.cost || 0;
                local_num += (e.local_share || 0) * (e.totals?.calls || 0);
                local_den += e.totals?.calls || 0;
            }
            events += s.memory?.events || 0;
            beliefs += s.memory?.beliefs || 0;
            skills += s.skills?.count || 0;
            if (s.cognition?.state === 'pursuing') pursuing++;
        }
        const share = local_den ? local_num / local_den : null;
        // status color + explicit label: the 70% bar is the Phase 6 target
        const shareCls = share === null ? '' : share >= 0.7 ? 'good' : share >= 0.4 ? 'warning' : 'critical';
        return '<div class="sim-tiles">'
            + tile('Agents', agents.length, `${pursuing} pursuing a goal`)
            + tile('Local calls', share === null ? '—' : Math.round(share * 100) + '%', 'target ≥70%', shareCls)
            + tile('Calls / hr', calls, 'all agents')
            + tile('Cost / hr', '$' + cost.toFixed(2), '$' + (cost * 24).toFixed(2) + ' per day')
            + tile('Memories', events, `${beliefs} beliefs formed`)
            + tile('Skills learned', skills, 'reusable programs')
            + '</div>';
    }

    function renderDrives(cog) {
        // drive state exists even when the loop is off; showing it beside
        // "cognition disabled" just confuses
        if (!cog?.enabled) return '';
        const drives = cog?.urgencies || [];
        if (drives.length === 0) return '';
        const active = cog?.drive;
        const rows = drives.map(d => {
            const pct = Math.max(0, Math.min(1, d.urgency)) * 100;
            const cls = (d.name === active ? ' active' : '') + (d.on_cooldown ? ' cooldown' : '');
            return `<div class="sim-drive${cls}">`
                + `<span class="name">${esc(d.name)}</span>`
                + `<span class="track"><span class="fill" style="width:${pct.toFixed(1)}%"></span></span>`
                + `<span class="num">${d.urgency.toFixed(2)}</span></div>`;
        }).join('');
        return `<div class="sim-section"><div class="heading">Drives — urgency</div>${rows}</div>`;
    }

    function renderGoal(cog) {
        if (!cog) return '';
        if (cog.state !== 'pursuing') {
            const why = cog.enabled ? 'content — no drive urgent enough' : 'cognition disabled';
            return `<div class="sim-section"><div class="heading">Goal</div><div class="sim-step">${esc(why)}</div></div>`;
        }
        const step = cog.step;
        let bar = '';
        if (step && step.total > 0) {
            bar = '<div class="sim-progress">' + Array.from({ length: step.total }, (_, i) =>
                `<i class="${i + 1 < step.index ? 'done' : i + 1 === step.index ? 'current' : ''}"></i>`).join('') + '</div>';
        }
        return '<div class="sim-section"><div class="heading">Goal</div>'
            + `<div class="sim-goal">${esc(cog.goal)} <span class="drive-tag">(${esc(cog.drive)})</span></div>`
            + (step ? `<div class="sim-step">Step ${step.index}/${step.total}: ${esc(step.text)}</div>` : '')
            + bar
            + (cog.last_thought ? `<div class="sim-thought">“${esc(cog.last_thought)}”</div>` : '')
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
            return `<div class="sim-rel"><span class="name">${esc(r.name)}</span>`
                + `<span class="axis">${bar}</span>`
                + `<span class="num">${d >= 0 ? '+' : ''}${d.toFixed(2)}${grudge}</span></div>`;
        }).join('');
        return `<div class="sim-section"><div class="heading">Relationships — hostile ← → warm</div>${rows}</div>`;
    }

    function renderAgent(name, s) {
        if (!s || s.error)
            return `<div class="sim-agent"><header><h3>${esc(name)}</h3><span class="state offline">offline</span></header></div>`;
        const cog = s.cognition;
        const state = cog?.state === 'pursuing' ? 'pursuing' : (s.action?.current || 'idle');
        const mem = s.memory, sk = s.skills, ec = s.economics;
        const facts = [
            mem?.enabled ? `${mem.events} memories · ${mem.beliefs} beliefs` : null,
            sk?.enabled ? `${sk.count} skills · ${sk.total_uses} uses` : null,
            ec ? `${Math.round((ec.local_share ?? 0) * 100)}% local · $${(ec.per_hour?.cost ?? 0).toFixed(2)}/hr` : null,
        ].filter(Boolean).join('  |  ');
        return `<div class="sim-agent"><header><h3>${esc(name)}</h3>`
            + `<span class="state">${esc(state)}</span></header>`
            + renderGoal(cog)
            + renderDrives(cog)
            + renderRelationships(s.social)
            + (facts ? `<div class="sim-section"><div class="heading">Systems</div><div class="sim-step">${esc(facts)}</div></div>` : '')
            + '</div>';
    }

    function renderFeed() {
        if (feed.length === 0)
            return '<div class="sim-event"><span class="when"></span><span class="who"></span>'
                + '<span class="what">No events yet. The feed is fed by the memory system — enable use_memory to populate it.</span></div>';
        return feed.map(e => {
            // hasOwn: a type of 'constructor'/'toString' would otherwise return an
            // inherited value and stringify into the class attribute
            const kind = Object.hasOwn(EVENT_KIND, e.type) ? EVENT_KIND[e.type] : 'other';
            return `<div class="sim-event k-${kind}"><span class="when">${esc(clock(e.ts))}</span>`
                + `<span class="who">${esc(e.agent)}</span>`
                + `<span class="what">${esc(e.content)}</span></div>`;
        }).join('');
    }

    function render() {
        const root = document.getElementById('sim');
        if (!root || !root.classList.contains('active')) return;
        const states = window.lastStates || {};
        const names = Object.keys(states);
        const body = document.getElementById('simBody');
        if (!body) return;
        if (names.length === 0) {
            body.innerHTML = '<div class="sim-empty">No agents are reporting yet. Start an agent from the Agents tab.</div>';
            return;
        }
        const feedEl = document.querySelector('#simBody .sim-feed');
        const scroll = feedEl ? feedEl.scrollTop : 0;
        body.innerHTML = renderTiles(states)
            + '<div class="sim-agents">' + names.map(n => renderAgent(n, states[n])).join('') + '</div>'
            + '<div class="sim-section"><div class="heading">Event feed</div>'
            + '<div class="sim-legend">'
            + '<span style="color:var(--series-1)">◆ goals</span>'
            + '<span style="color:var(--series-2)">▲ skills</span>'
            + '<span style="color:var(--series-3)">● social</span>'
            + '<span style="color:var(--critical)">✖ deaths</span>'
            + '</div>'
            + `<div class="sim-feed">${renderFeed()}</div></div>`;
        const newFeed = document.querySelector('#simBody .sim-feed');
        if (newFeed && scroll) newFeed.scrollTop = scroll; // don't yank the reader back to the top every second
    }

    window.simRender = render;
    window.simPushEvent = function (ev) {
        if (!ev || !ev.content) return;
        feed.unshift({ ts: ev.ts || Date.now(), agent: ev.agent || '?', type: ev.type || 'other', content: ev.content });
        if (feed.length > MAX_FEED) feed.length = MAX_FEED;
        render();
    };
    window.simSetTv = function (on) {
        tv = on;
        const root = document.getElementById('sim');
        if (root) root.classList.toggle('tv', tv);
        const btn = document.getElementById('tvModeBtn');
        if (btn) btn.textContent = tv ? 'Exit TV mode' : 'TV mode';
        render();
    };
    window.simIsTv = () => tv;
})();
