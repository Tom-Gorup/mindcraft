// Profile editor: builds a form from public/profile_spec.json so every
// profile key — drives, social, cognition, memory, skills, tiers, modes,
// prompts — is editable in the browser. Adding a key to the spec is all it
// takes to get UI for it.
/* global io */
(function () {
    'use strict';

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
            input = `<input type="checkbox" id="${id}" data-path="${esc(path)}" data-type="boolean" ${value ? 'checked' : ''}>`;
        } else if (def.type === 'number') {
            const attrs = [def.min !== undefined ? `min="${def.min}"` : '', def.max !== undefined ? `max="${def.max}"` : '', def.step !== undefined ? `step="${def.step}"` : ''].join(' ');
            input = `<input type="number" id="${id}" data-path="${esc(path)}" data-type="number" ${attrs} value="${value ?? ''}" placeholder="${def.default ?? ''}">`;
        } else if (def.type === 'prompt') {
            input = `<textarea id="${id}" data-path="${esc(path)}" data-type="string" rows="4">${esc(value ?? '')}</textarea>`;
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
                html += (def.type === 'object') ? objectBlock(key, def) : field(key, def, profile[key]);
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
            if (type === 'boolean') value = el.checked;
            else if (type === 'number') value = el.value === '' ? undefined : Number(el.value);
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

    window.openProfileEditor = function (name) {
        agentName = name;
        const modal = document.getElementById('profileEditorModal');
        const title = document.getElementById('profileEditorTitle');
        const err = document.getElementById('profileEditorError');
        if (err) err.textContent = '';
        if (title) title.textContent = `Configure ${name}`;
        modal.style.display = 'flex';
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
        document.getElementById('profileEditorModal').style.display = 'none';
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
            if (res?.success) window.closeProfileEditor();
            else if (err) err.textContent = res?.error || 'Save failed';
        });
    };
})();
