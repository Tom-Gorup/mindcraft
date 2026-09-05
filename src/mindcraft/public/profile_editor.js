// Profile editor: builds a form from public/profile_spec.json so every
// profile key — drives, social, cognition, memory, skills, tiers, modes,
// prompts — is editable in the browser. Adding a key to the spec is all it
// takes to get UI for it.
/* global io */
(function () {
    'use strict';

    // Kept in sync with src/models/cache.js. Everything before this marker is
    // sent as a cacheable block; everything after is per-call.
    const CACHE_MARKER = '\n<<<CACHE_BOUNDARY>>>\n';
    // The placeholders that change on every call. The boundary belongs
    // immediately before whichever appears first.
    const VOLATILE = ['$EXAMPLES', '$SELF_PROMPT', '$MEMORY', '$SOCIAL', '$STATS',
        '$INVENTORY', '$TO_SUMMARIZE', '$RELEVANT_MEMORIES'];

    // `socket` is created by the page's main script; reach it off window so
    // this module has no implicit global dependency.
    const sock = () => window.socket;

    let spec = null;
    let profile = null;
    let agentName = null;

    const SECTIONS = [
        ['identity', 'Identity'],
        ['models', 'Models'],
        ['routing', 'Model routing'],
        ['personality', 'Personality'],
        ['behavior', 'Behavior'],
        ['tuning', 'Tuning'],
        ['prompts', 'Prompts'],
    ];

    function esc(v) {
        return String(v ?? '')
            .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    }

    // path is a dotted key list, e.g. "drives.curiosity.weight"
    function get(obj, path) {
        return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    }
    function set(obj, path, value) {
        const keys = path.split('.');
        const last = keys.pop();
        let cur = obj;
        for (const k of keys) {
            if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
            cur = cur[k];
        }
        if (value === undefined || value === '') delete cur[last];
        else cur[last] = value;
    }

    function field(path, def, value) {
        const id = 'pf_' + path.replace(/\./g, '__');
        const desc = def.description ? `<div class="pf-desc">${esc(def.description)}</div>` : '';
        const label = `<label for="${id}">${esc(path.split('.').pop())}</label>`;
        let input;
        if (def.type === 'boolean') {
            // Show the EFFECTIVE value: a key absent from the profile is
            // inherited from the defaults, not off. Rendering it unchecked and
            // then saving would write `false` and, because profile keys replace
            // whole objects, silently disable every default-on reflex —
            // including self_preservation.
            const effective = (value === undefined) ? !!def.default : !!value;
            const inherited = value === undefined ? ' data-inherited="1"' : '';
            input = `<input type="checkbox" id="${id}" data-path="${esc(path)}" data-type="boolean"${inherited} ${effective ? 'checked' : ''}>`;
        } else if (def.type === 'number') {
            const attrs = [def.min !== undefined ? `min="${esc(def.min)}"` : '', def.max !== undefined ? `max="${esc(def.max)}"` : '', def.step !== undefined ? `step="${esc(def.step)}"` : ''].join(' ');
            input = `<input type="number" id="${id}" data-path="${esc(path)}" data-type="number" ${attrs} value="${esc(value ?? '')}" placeholder="${esc(def.default ?? '')}">`;
        } else if (def.type === 'prompt') {
            // Prompt caching is a checkbox, not a marker the user has to type.
            // The boundary has to sit in the right PLACE — after the static
            // persona and command docs, before the first per-call placeholder —
            // and getting that wrong silently costs money rather than breaking,
            // so it is not something to leave to hand-editing.
            const cached = typeof value === 'string' && value.includes(CACHE_MARKER);
            input = `<textarea id="${id}" data-path="${esc(path)}" data-type="string" rows="4">${esc(value ?? '')}</textarea>`
                + `<label class="pf-cache"><input type="checkbox" id="${id}-cache" data-cache-for="${id}"`
                + `${cached ? ' checked' : ''} onchange="pfToggleCache('${id}')">`
                + ` Cache the static part of this prompt`
                + `<span class="pf-cache-hint" id="${id}-cache-hint"></span></label>`;
        } else if (def.type === 'model') {
            const shown = (value && typeof value === 'object') ? JSON.stringify(value) : (value ?? '');
            input = `<input type="text" id="${id}" data-path="${esc(path)}" data-type="model" value="${esc(shown)}" placeholder="${esc(def.default ?? 'provider/model')}">`;
        } else {
            input = `<input type="text" id="${id}" data-path="${esc(path)}" data-type="string" value="${esc(value ?? '')}" placeholder="${esc(def.default ?? '')}">`;
        }
        return `<div class="pf-field">${label}${input}${desc}</div>`;
    }

    function objectBlock(key, def) {
        const value = profile[key] || {};
        let inner = '';
        if (def.fields) {
            // an object with a fixed field list (social, cognition, tiers, ...)
            if (def.keys) {
                // ...repeated per named key (drives)
                for (const sub of def.keys) {
                    inner += `<div class="pf-sub"><div class="pf-sub-title">${esc(sub)}</div>`;
                    for (const [fk, fd] of Object.entries(def.fields))
                        inner += field(`${key}.${sub}.${fk}`, fd, get(profile, `${key}.${sub}.${fk}`));
                    inner += '</div>';
                }
            } else {
                for (const [fk, fd] of Object.entries(def.fields))
                    inner += field(`${key}.${fk}`, fd, get(profile, `${key}.${fk}`));
            }
        } else {
            inner = `<div class="pf-desc">${esc(JSON.stringify(value))}</div>`;
        }
        return `<details class="pf-group"${def.advanced ? '' : ' open'}><summary>${esc(key)}`
            + (def.description ? ` <span class="pf-desc-inline">${esc(def.description)}</span>` : '')
            + `</summary>${inner}</details>`;
    }

    function render() {
        const host = document.getElementById('profileEditorForm');
        if (!host || !spec) return;
        let html = '';
        for (const [sect, title] of SECTIONS) {
            const keys = Object.keys(spec).filter(k => !k.startsWith('_') && spec[k].section === sect);
            if (keys.length === 0) continue;
            html += `<div class="pf-section"><h4>${esc(title)}</h4>`;
            for (const key of keys) {
                const def = spec[key];
                if (def.type === 'object') html += objectBlock(key, def);
                else if (def.advanced) {
                    // collapse advanced scalars (notably the nine prompt
                    // templates) or the form overflows the modal
                    html += `<details class="pf-group"><summary>${esc(key)}`
                        + (def.description ? ` <span class="pf-desc-inline">${esc(def.description)}</span>` : '')
                        + `</summary>${field(key, def, profile[key])}</details>`;
                }
                else html += field(key, def, profile[key]);
            }
            html += '</div>';
        }
        host.innerHTML = html;
    }

    function collect() {
        const edited = JSON.parse(JSON.stringify(profile));
        for (const el of document.querySelectorAll('#profileEditorForm [data-path]')) {
            const path = el.dataset.path;
            const type = el.dataset.type;
            let value;
            if (type === 'boolean') {
                // don't materialize an inherited default the user never touched
                if (el.dataset.inherited === '1' && el.checked === el.defaultChecked) continue;
                value = el.checked;
            }
            else if (type === 'number') {
                if (el.value === '') value = undefined;
                else if (!el.checkValidity()) throw new Error(`${path}: ${el.validationMessage || 'out of range'}`);
                else value = Number(el.value);
            }
            else if (type === 'model') {
                const raw = el.value.trim();
                if (!raw) value = undefined;
                else if (raw.startsWith('{')) {
                    try { value = JSON.parse(raw); }
                    catch { throw new Error(`${path}: not valid JSON`); }
                } else value = raw;
            }
            else value = el.value === '' ? undefined : el.value;
            set(edited, path, value);
        }
        return edited;
    }

    // Insert or remove the boundary for a template, positioning it correctly.
    window.pfToggleCache = function (id) {
        const ta = document.getElementById(id);
        const box = document.getElementById(id + '-cache');
        if (!ta || !box) return;
        let text = ta.value.split(CACHE_MARKER).join('\n');   // always normalise first
        if (box.checked) {
            // first volatile placeholder marks where the per-call content starts
            let at = -1;
            for (const v of VOLATILE) {
                const i = text.indexOf(v);
                if (i !== -1 && (at === -1 || i < at)) at = i;
            }
            if (at === -1) {
                box.checked = false;
                pfCacheHint(id, 'no per-call placeholder found — nothing to cache before', true);
                return;
            }
            text = text.slice(0, at) + CACHE_MARKER + text.slice(at);
        }
        ta.value = text;
        pfCacheHint(id);
    };

    // Say whether the prefix is actually big enough to cache. Below the model's
    // floor a breakpoint is silently ignored: no error, no hit, and the
    // cache-write premium charged anyway.
    function pfCacheHint(id, override, isError) {
        const el = document.getElementById(id + '-cache-hint');
        const ta = document.getElementById(id);
        if (!el || !ta) return;
        if (override) {
            el.textContent = ' — ' + override;
            el.classList.toggle('bad', !!isError);
            return;
        }
        const i = ta.value.indexOf(CACHE_MARKER.trim());
        if (i === -1) { el.textContent = ''; return; }
        // $COMMAND_DOCS and $STATIC_EXAMPLES expand to a few thousand tokens at
        // render time, so a raw character count badly understates the prefix.
        const raw = Math.round(ta.value.slice(0, i).length / 3.5);
        const expands = (ta.value.slice(0, i).match(/\$COMMAND_DOCS|\$STATIC_EXAMPLES/g) || []).length;
        el.classList.remove('bad');
        el.textContent = expands
            ? ` — ~${raw} tokens plus expansions; verify with tools/count_prompt_tokens.mjs`
            : ` — ~${raw} tokens (Haiku needs 4096, Sonnet 1024)`;
    }
    window.pfCacheHint = pfCacheHint;

    window.openProfileEditor = function (name) {
        agentName = name;
        const modal = document.getElementById('profileEditorModal');
        const title = document.getElementById('profileEditorTitle');
        const err = document.getElementById('profileEditorError');
        if (err) err.textContent = '';
        if (title) title.textContent = `Configure ${name}`;
        modal.classList.add('open');
        sock().emit('get-profile-spec', (res) => {
            spec = res?.spec || {};
            sock().emit('get-profile', name, (r) => {
                if (!r?.success) {
                    if (err) err.textContent = r?.error || 'Could not load profile';
                    return;
                }
                profile = r.profile || {};
                render();
            });
        });
    };

    window.closeProfileEditor = function () {
        document.getElementById('profileEditorModal').classList.remove('open');
    };

    window.saveProfileEditor = function () {
        const err = document.getElementById('profileEditorError');
        let edited;
        try {
            edited = collect();
        } catch (e) {
            if (err) err.textContent = e.message;
            return;
        }
        sock().emit('set-profile', agentName, edited, (res) => {
            if (!res?.success) {
                if (err) err.textContent = res?.error || 'Save failed';
                return;
            }
            window.closeProfileEditor();
            // Say whether it was actually written. These edits used to apply to
            // the running agent and vanish on the next restart, with nothing in
            // the UI to suggest they had not been kept.
            if (res.persisted === false)
                window.toast?.('Applied but not saved',
                    res.warning || 'It will be lost on the next restart.', 'warning');
            else if (res.saved_keys?.length)
                window.toast?.('Saved', `${res.saved_keys.join(', ')} — kept across restarts.`, 'good');
            else
                window.toast?.('Back to profile defaults', 'No local overrides remain.', 'good');
        });
    };
})();
