/* ============================================================================
   Mindcraft — shared UI behaviour: theme, toasts, tooltips, tab indicator,
   keyboard shortcuts, number formatting.

   Loaded before the view modules; everything it exposes hangs off window.
   No framework, no build step — this file is served as-is.
   ========================================================================= */
(function () {
    'use strict';

    /* ------------------------------------------------------------- escape */
    // Agent names and chat text originate in Minecraft and are untrusted.
    // Anything that reaches innerHTML goes through here first.
    function esc(v) {
        return String(v ?? '')
            .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    }
    window.esc = esc;

    /* -------------------------------------------------------------- theme */

    const THEME_KEY = 'mindcraft.theme';
    function applyTheme(mode) {
        // 'system' removes the stamp and lets the media query decide
        if (mode === 'system') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', mode);
        try { localStorage.setItem(THEME_KEY, mode); } catch { /* private mode */ }
        const btn = document.getElementById('themeBtn');
        if (btn) {
            const resolved = resolvedTheme();
            btn.setAttribute('aria-label', `Theme: ${mode}. Switch to ${mode === 'dark' ? 'light' : 'dark'}.`);
            btn.dataset.mode = resolved;
        }
    }
    function resolvedTheme() {
        const stamp = document.documentElement.getAttribute('data-theme');
        if (stamp) return stamp;
        return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    window.toggleTheme = function () {
        applyTheme(resolvedTheme() === 'dark' ? 'light' : 'dark');
    };
    // Applied as early as possible so there is no flash of the wrong theme.
    try {
        const saved = localStorage.getItem(THEME_KEY);
        if (saved) applyTheme(saved);
    } catch { /* ignore */ }

    /* ------------------------------------------------------------- toasts */

    let toastStack = null;
    function stack() {
        if (!toastStack) {
            toastStack = document.createElement('div');
            toastStack.className = 'toast-stack';
            toastStack.setAttribute('role', 'status');
            toastStack.setAttribute('aria-live', 'polite');
            document.body.appendChild(toastStack);
        }
        return toastStack;
    }
    const TOAST_ICON = { good: '✓', warning: '!', critical: '✕', info: 'i' };
    // level: 'good' | 'warning' | 'critical' | 'info'
    window.toast = function (title, message, level = 'info', ms = 5000) {
        const el = document.createElement('div');
        el.className = 'toast ' + (level === 'info' ? '' : level);
        const icon = document.createElement('span');
        icon.className = 't-icon';
        icon.textContent = TOAST_ICON[level] || 'i';
        const body = document.createElement('div');
        body.className = 't-body';
        const t = document.createElement('div');
        t.className = 't-title';
        t.textContent = title;                       // untrusted: textContent
        body.appendChild(t);
        if (message) {
            const m = document.createElement('div');
            m.className = 't-msg';
            m.textContent = message;
            body.appendChild(m);
        }
        el.append(icon, body);
        stack().appendChild(el);
        const kill = () => {
            el.classList.add('leaving');
            setTimeout(() => el.remove(), 220);
        };
        const timer = setTimeout(kill, ms);
        el.addEventListener('click', () => { clearTimeout(timer); kill(); });
        return el;
    };

    /* ------------------------------------------------------------ tooltip */
    /* One shared element. Any node with data-tip gets a hover/focus readout;
       the tooltip enhances, it never gates — every value it shows is also in
       a label or a table. */

    let tipEl = null;
    function tip() {
        if (!tipEl) {
            tipEl = document.createElement('div');
            tipEl.className = 'tip';
            tipEl.setAttribute('role', 'tooltip');
            document.body.appendChild(tipEl);
        }
        return tipEl;
    }
    function showTip(target, x, y) {
        const raw = target.getAttribute('data-tip');
        if (!raw) return;
        const el = tip();
        el.textContent = '';
        // "value\tlabel\tcolorRole" per line; a bare line is plain text
        for (const line of raw.split('\n')) {
            const row = document.createElement('div');
            row.className = 'tip-row';
            const parts = line.split('\t');
            if (parts.length > 1) {
                if (parts[2]) {
                    const key = document.createElement('span');
                    key.className = 'tip-key';
                    key.style.background = `var(--${parts[2]})`;
                    row.appendChild(key);
                }
                const k = document.createElement('span');
                k.className = 'tip-k';
                k.textContent = parts[1];            // untrusted
                const v = document.createElement('span');
                v.className = 'tip-v';
                v.textContent = parts[0];
                row.append(k, v);
            } else {
                row.textContent = line;
            }
            el.appendChild(row);
        }
        el.classList.add('show');
        position(el, x, y);
    }
    function position(el, x, y) {
        const r = el.getBoundingClientRect();
        let left = x + 14, top = y + 14;
        if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
        if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
        el.style.left = Math.max(8, left) + 'px';
        el.style.top = Math.max(8, top) + 'px';
    }
    function hideTip() { if (tipEl) tipEl.classList.remove('show'); }

    document.addEventListener('pointermove', (e) => {
        const t = e.target.closest?.('[data-tip]');
        if (t) showTip(t, e.clientX, e.clientY);
        else hideTip();
    }, { passive: true });
    document.addEventListener('pointerleave', hideTip, { passive: true });
    // keyboard parity: same details on focus as on hover
    document.addEventListener('focusin', (e) => {
        const t = e.target.closest?.('[data-tip]');
        if (!t) return hideTip();
        const r = t.getBoundingClientRect();
        showTip(t, r.left + r.width / 2, r.bottom);
    });
    document.addEventListener('focusout', hideTip);
    window.addEventListener('scroll', hideTip, { passive: true, capture: true });

    /* -------------------------------------------------------- tab indicator */

    window.moveTabInk = function () {
        const bar = document.querySelector('.tab-bar');
        const ink = bar?.querySelector('.tab-ink');
        const active = bar?.querySelector('.tab-btn.active');
        if (!bar || !ink || !active) return;
        ink.style.width = active.offsetWidth + 'px';
        ink.style.transform = `translateX(${active.offsetLeft - 3}px)`;
    };
    window.addEventListener('resize', () => window.moveTabInk());

    /* ------------------------------------------------------------ numbers */

    // 1284 -> "1,284"; 12934 -> "12.9K"; 4200000 -> "4.2M"
    window.compact = function (n) {
        const v = Number(n) || 0;
        const a = Math.abs(v);
        if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (a >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
        return v.toLocaleString();
    };

    // A stable hue per agent name, so an agent keeps its colour across
    // renders and reloads. Identity follows the entity, never its position.
    window.hueFor = function (name) {
        let h = 0;
        const s = String(name ?? '');
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
        return h;
    };

    /* -------------------------------------------------------- shortcuts */

    const HELP = [
        ['1 / 2 / 3', 'Switch to Agents / Sim / Reports'],
        ['t', 'Toggle TV mode (Sim)'],
        ['d', 'Toggle dark / light'],
        ['?', 'This list'],
        ['Esc', 'Close a dialog'],
    ];
    document.addEventListener('keydown', (e) => {
        // never hijack typing
        const tag = (e.target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        if (e.key === 'Escape') {
            const open = document.querySelector('.modal-backdrop.open');
            if (open) { open.classList.remove('open'); e.preventDefault(); }
            return;
        }
        if (e.key === '1') window.showView?.('agents');
        else if (e.key === '2') window.showView?.('sim');
        else if (e.key === '3') window.showView?.('reports');
        else if (e.key === 't' && document.getElementById('sim')?.classList.contains('active')) window.simSetTv?.(!window.simIsTv?.());
        else if (e.key === 'd') window.toggleTheme();
        else if (e.key === '?') {
            window.toast('Keyboard shortcuts', HELP.map(([k, v]) => `${k} — ${v}`).join('\n'), 'info', 9000);
        }
    });
})();
