// Phase 9 — projects: ambition that outlives a goal.
//
// The cognition loop is episodic by construction. A goal is generated, pursued,
// and ends when its drive eases or its budget runs out; nothing carries across.
// That is correct for needs — you do not resume being hungry — but it makes
// long-horizon work impossible. An agent cannot build a castle in twelve
// minutes, and being interrupted by nightfall should be a pause, not an
// abandonment.
//
// A project is the missing noun. It holds an intent, a coarse list of
// milestones, a materials ledger and a site, and it persists across goals,
// sessions and restarts. Goals become the means by which a project advances
// rather than the unit of ambition itself.
//
// Deliberately NOT here:
//   · block coordinates or build steps — that is the blueprint layer
//   · anything the model must emit as JSON beyond an intent and milestones,
//     because a small model is bad at long structured output
//   · scoring or "quality", which is the taste layer
//
// Pure: no agent references, no I/O. Unit-testable.

const MAX_MILESTONES = 8;
const MAX_NOTES = 12;

function clampStr(v, n) {
    return String(v ?? '').trim().substring(0, n);
}

export class Project {
    constructor(data = {}) {
        this.id = data.id ?? `p${Math.round(data.created_at ?? 0)}`;
        this.intent = clampStr(data.intent, 200);
        this.drive = data.drive ?? 'legacy';
        this.created_at = data.created_at ?? 0;
        this.last_worked_at = data.last_worked_at ?? this.created_at;
        this.active_ms = data.active_ms ?? 0;
        this.site = data.site ?? null;              // {x,y,z} once chosen
        this.status = data.status ?? 'active';      // active | complete | abandoned
        // attempts is what makes an overnight run diagnosable: a project stuck
        // on milestone 1 for eight hours looks identical to one making steady
        // progress unless you count how many times it has been tried.
        this.milestones = (data.milestones ?? []).slice(0, MAX_MILESTONES)
            .map(m => ({ text: clampStr(m.text, 160), done: !!m.done, attempts: m.attempts ?? 0 }));
        // What the agent has decided it needs, and what it has actually put in.
        // Counts are cumulative contributions, not current inventory — a project
        // should not un-build itself because the agent spent its logs elsewhere.
        this.materials = { needed: { ...(data.materials?.needed ?? {}) },
            contributed: { ...(data.materials?.contributed ?? {}) } };
        this.notes = (data.notes ?? []).slice(-MAX_NOTES);
        this.sessions = data.sessions ?? 0;         // how many agent lifetimes it has spanned
        this.stall_attempts = data.stall_attempts ?? 6;
    }

    get nextMilestone() {
        return this.milestones.find(m => !m.done) ?? null;
    }

    get progress() {
        if (this.milestones.length === 0) return 0;
        return this.milestones.filter(m => m.done).length / this.milestones.length;
    }

    get isFinished() {
        return this.status !== 'active'
            || (this.milestones.length > 0 && this.milestones.every(m => m.done));
    }

    noteAttempt() {
        const m = this.nextMilestone;
        if (m) m.attempts = (m.attempts ?? 0) + 1;
    }

    // A milestone attempted many times without completing is the signal that
    // the plan is wrong rather than the work being slow. The taste/revision
    // layer will act on this; for now it is reported so a human can see it.
    get stalledMilestone() {
        const m = this.nextMilestone;
        return m && (m.attempts ?? 0) >= this.stall_attempts ? m : null;
    }

    completeNextMilestone(note = '') {
        const m = this.nextMilestone;
        if (!m) return false;
        m.done = true;
        if (note) this.addNote(note);
        if (!this.nextMilestone) this.status = 'complete';
        return true;
    }

    contribute(item, qty) {
        const n = Number(qty);
        if (!item || !Number.isFinite(n) || n <= 0) return;
        const key = String(item).substring(0, 64);
        this.materials.contributed[key] = (this.materials.contributed[key] ?? 0) + n;
    }

    // What is still outstanding, for the prompt. Only reports shortfalls.
    get outstanding() {
        const out = {};
        for (const [item, need] of Object.entries(this.materials.needed)) {
            const have = this.materials.contributed[item] ?? 0;
            if (have < need) out[item] = need - have;
        }
        return out;
    }

    addNote(text) {
        const t = clampStr(text, 240);
        if (!t) return;
        this.notes.push(t);
        if (this.notes.length > MAX_NOTES) this.notes.splice(0, this.notes.length - MAX_NOTES);
    }

    // Compact enough to sit in a prompt without crowding out everything else.
    describe() {
        const done = this.milestones.filter(m => m.done).length;
        let text = `Project: ${this.intent}\n`;
        text += `Progress: ${done}/${this.milestones.length} milestones`;
        if (this.sessions > 0) text += `, worked across ${this.sessions + 1} sessions`;
        text += '\n';
        const next = this.nextMilestone;
        if (next) {
            text += `Next: ${next.text}`;
            // Tell the model plainly when it is going in circles, so the plan
            // can change rather than repeating.
            if ((next.attempts ?? 0) >= 2)
                text += ` (you have attempted this ${next.attempts} times without finishing it — try a different approach, or a smaller version of it)`;
            text += '\n';
        }
        const short = this.outstanding;
        const keys = Object.keys(short);
        if (keys.length)
            text += `Still needed: ${keys.slice(0, 6).map(k => `${short[k]} ${k}`).join(', ')}\n`;
        if (this.site) text += `Site: x${this.site.x} y${this.site.y} z${this.site.z}\n`;
        if (this.notes.length) text += `Learned so far: ${this.notes.slice(-3).join(' | ')}\n`;
        return text.trim();
    }

    toJSON() {
        return {
            id: this.id, intent: this.intent, drive: this.drive,
            created_at: this.created_at, last_worked_at: this.last_worked_at,
            active_ms: this.active_ms, site: this.site, status: this.status,
            milestones: this.milestones, materials: this.materials, stall_attempts: this.stall_attempts,
            notes: this.notes, sessions: this.sessions,
        };
    }
}

// Holds one active project plus a finished history, so "what has this agent
// actually made" is answerable — which is what a legacy drive is really asking.
export class ProjectStore {
    constructor(data = {}, opts = {}) {
        this.max_history = opts.max_history ?? 20;
        this.projects = (data.projects ?? []).map(p => new Project(p));
    }

    get active() {
        return this.projects.find(p => p.status === 'active') ?? null;
    }

    get completed() {
        return this.projects.filter(p => p.status === 'complete');
    }

    start(intent, milestones, { drive = 'legacy', now = 0, needed = {} } = {}) {
        // One at a time. An agent juggling three castles finishes none, and the
        // arbiter already has enough ways to thrash.
        const current = this.active;
        if (current) return current;
        const p = new Project({
            id: `p${now}`, intent, drive, created_at: now, last_worked_at: now,
            milestones: (milestones ?? []).map(text => ({ text, done: false })),
            materials: { needed, contributed: {} },
        });
        this.projects.push(p);
        this._trim();
        return p;
    }

    abandonActive(reason, now = 0) {
        const p = this.active;
        if (!p) return null;
        p.status = 'abandoned';
        p.last_worked_at = now;
        p.addNote(`Abandoned: ${reason}`);
        return p;
    }

    // Called each tick while the agent is actually working the project.
    noteWork(delta_ms, now = 0) {
        const p = this.active;
        if (!p) return;
        p.active_ms += delta_ms;
        p.last_worked_at = now;
    }

    // A restart is a new session for whatever was in flight. Counting them is
    // how "finished across several sessions" becomes checkable rather than
    // anecdotal.
    noteSession() {
        const p = this.active;
        if (p) p.sessions += 1;
    }

    _trim() {
        const finished = this.projects.filter(p => p.status !== 'active');
        if (finished.length > this.max_history) {
            const drop = new Set(finished.slice(0, finished.length - this.max_history));
            this.projects = this.projects.filter(p => !drop.has(p));
        }
    }

    // For the legacy drive: how satisfied should it be, given what stands?
    // Completed work satisfies; an untouched ambition does not.
    satisfaction() {
        const done = this.completed.length;
        if (done === 0) return 0;
        return Math.min(1, 0.4 + 0.2 * done);   // first build matters most
    }

    toJSON() {
        return { projects: this.projects.map(p => p.toJSON()) };
    }
}
