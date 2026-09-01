// Pure drive-state logic: no imports, no agent references, unit-testable.
// A drive is a personality-weighted need with a satisfaction level in [0,1].
// 'sensor' drives take their level directly from world sensors each update;
// 'decay' drives fall over time and are raised by satisfy() when events occur.
// Urgency = weight * (1 - level); the arbiter picks the most urgent drive.

export const DEFAULT_DRIVES = {
    safety: {
        weight: 1.0,
        type: 'sensor',
        description: 'Stay alive and unharmed. Urgent when health is low, hostiles are near, or recently damaged.',
    },
    food: {
        weight: 0.9,
        type: 'sensor',
        description: 'Keep hunger topped up and hold spare food. Urgent when hungry or carrying no food.',
    },
    curiosity: {
        weight: 0.6,
        type: 'decay',
        decay_per_min: 0.015,
        initial_level: 0.5, // agents spawn curious, not sated
        description: 'Explore new places, discover resources, try new things.',
    },
    social: {
        weight: 0.5,
        type: 'decay',
        decay_per_min: 0.01,
        initial_level: 0.85,
        description: 'Interact with players and other bots.',
    },
    wealth: {
        weight: 0.4,
        type: 'sensor',
        description: 'Accumulate valuable resources, tools, and equipment.',
    },
    // ---- aspiration drives (Phase 9) ----
    // These differ from the needs above in kind, not just in weight. A need
    // spikes and is satisfied by one action; an aspiration presses gently for
    // hours and is only satisfied by something that lasts. The slow decay is
    // the point: it never wins on urgency alone, which is what the arbiter's
    // neglect term is for.
    legacy: {
        weight: 0.7,
        type: 'decay',
        decay_per_min: 0.0015,   // ~11 hours from sated to fully unsatisfied
        initial_level: 0.6,
        aspiration: true,
        description: 'Build something permanent and worth remembering. Satisfied by lasting work, '
            + 'not by gathering or surviving. Never urgent, never absent.',
    },
};

function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}

export class DriveState {
    // config: optional per-drive overrides from the profile's "drives" block.
    // Unknown drive names are accepted as custom decay drives.
    constructor(config = {}, opts = {}) {
        // How much a fully-neglected aspiration can add to its own urgency, and
        // how long "fully neglected" takes. Defaults chosen so a legacy drive
        // wins roughly twice an hour when nothing is on fire.
        this.neglect_bonus_max = opts.neglect_bonus_max ?? 0.30;
        this.neglect_full_ms = opts.neglect_full_ms ?? 25 * 60000;
        // Ambition waits while something is genuinely wrong. Above this need
        // urgency, aspirations forfeit their neglect claim and compete on raw
        // urgency alone. Without it a long-neglected aspiration outranks being
        // at half health, which is exactly what the first overnight run did.
        this.needs_gate = opts.needs_gate ?? 0.55;
        // How fast an alarm fades. Half-life, not a hard window: the drive
        // should ease back rather than switch off.
        this.alarm_half_life_ms = opts.alarm_half_life_ms ?? 4 * 60000;
        this.drives = {};
        const names = new Set([...Object.keys(DEFAULT_DRIVES), ...Object.keys(config)]);
        for (const name of names) {
            const def = DEFAULT_DRIVES[name] || {};
            const cfg = config[name] || {};
            this.drives[name] = {
                name,
                weight: cfg.weight ?? def.weight ?? 0.5,
                aspiration: cfg.aspiration ?? def.aspiration ?? false,
                neglect_ms: 0,
                type: cfg.type ?? def.type ?? 'decay',
                decay_per_min: cfg.decay_per_min ?? def.decay_per_min ?? 0.01,
                description: cfg.description ?? def.description ?? '',
                level: clamp01(cfg.initial_level ?? def.initial_level ?? 1.0),
                cooldown_until: 0,
                alarm: 0,
            };
        }
    }

    exists(name) {
        return this.drives[name] != null;
    }

    update(delta_ms, sensor_levels = {}) {
        const fade = Math.pow(0.5, delta_ms / this.alarm_half_life_ms);
        for (const d of Object.values(this.drives)) {
            if (sensor_levels[d.name] !== undefined)
                d.level = clamp01(sensor_levels[d.name]);
            else if (d.type === 'decay')
                d.level = clamp01(d.level - d.decay_per_min * (delta_ms / 60000));

            // The alarm is applied AFTER the sensor, which is the whole point.
            // safety's level is health/20, so respawning at full health reports
            // perfect safety and erases the evidence that you just died. A
            // sensor has no memory; this is the memory.
            if (d.alarm > 0) {
                d.alarm *= fade;
                if (d.alarm < 0.01) d.alarm = 0;
                else d.level = Math.min(d.level, 1 - d.alarm);
            }
        }
    }

    // Something happened that the sensors will not remember. Raises the drive
    // and holds it raised while the alarm fades.
    raiseAlarm(name, level = 0.9) {
        const d = this.drives[name];
        if (!d) return;
        d.alarm = Math.max(d.alarm || 0, clamp01(level));
        d.level = Math.min(d.level, 1 - d.alarm);
    }

    satisfy(name, amount) {
        if (!this.exists(name)) return;
        this.drives[name].level = clamp01(this.drives[name].level + amount);
    }

    deplete(name, amount) {
        this.satisfy(name, -amount);
    }

    urgency(name) {
        const d = this.drives[name];
        if (!d) return 0;
        return d.weight * (1 - d.level);
    }

    // Raw urgency plus a claim earned by being passed over. Without this a
    // slow-decaying aspiration can never win: hunger and safety churn between
    // 0.4 and 0.9 all day, and a drive sitting at 0.3 is starved forever no
    // matter how long it waits. This is the mechanical difference between "a
    // need I have" and "a thing I keep meaning to do".
    effectiveUrgency(name) {
        const d = this.drives[name];
        if (!d) return 0;
        const raw = this.urgency(name);
        if (!this.neglect_bonus_max || !d.aspiration) return raw;
        if (this.needsArePressing()) return raw;
        const share = Math.min(1, (d.neglect_ms || 0) / this.neglect_full_ms);
        return raw + share * this.neglect_bonus_max;
    }

    // Is any actual need pressing? Aspirations are excluded by construction —
    // ambition never justifies suppressing ambition.
    needsArePressing() {
        for (const d of Object.values(this.drives)) {
            if (d.aspiration) continue;
            if (this.urgency(d.name) >= this.needs_gate) return true;
        }
        return false;
    }

    // Called each tick with the drive currently being acted on (or null).
    // Only aspirations accumulate neglect — a hunger you ignored is not a debt,
    // it just gets hungrier, which the sensor already reflects.
    noteAttention(delta_ms, current_name) {
        for (const d of Object.values(this.drives)) {
            if (!d.aspiration) continue;
            if (d.name === current_name) d.neglect_ms = 0;
            else d.neglect_ms = (d.neglect_ms || 0) + delta_ms;
        }
    }

    setCooldown(name, until_ts) {
        if (this.exists(name))
            this.drives[name].cooldown_until = until_ts;
    }

    // Sorted descending by urgency. on_cooldown drives are included but flagged.
    getUrgencies(now = Date.now()) {
        return Object.values(this.drives)
            .map(d => ({
                name: d.name,
                urgency: this.effectiveUrgency(d.name),
                raw_urgency: this.urgency(d.name),
                aspiration: !!d.aspiration,
                neglect_ms: d.neglect_ms || 0,
                level: d.level,
                weight: d.weight,
                alarm: d.alarm || 0,
                on_cooldown: d.cooldown_until > now,
            }))
            .sort((a, b) => b.urgency - a.urgency);
    }

    // Human/LLM-readable summary for the goal-generation prompt.
    describe(now = Date.now()) {
        let text = '';
        for (const u of this.getUrgencies(now)) {
            const d = this.drives[u.name];
            text += `- ${u.name} (urgency ${u.urgency.toFixed(2)}, satisfaction ${Math.round(u.level * 100)}%)`;
            if (d.description) text += `: ${d.description}`;
            if (u.alarm > 0.15) text += ' [you recently came to harm here — this is not a drill]';
            if (u.on_cooldown) text += ' [recently failed, avoid for now]';
            text += '\n';
        }
        return text.trim();
    }

    getJson() {
        const levels = {};
        for (const d of Object.values(this.drives))
            levels[d.name] = { level: d.level, cooldown_until: d.cooldown_until, alarm: d.alarm || 0 };
        return levels;
    }

    loadJson(json) {
        if (!json) return;
        for (const name in json) {
            if (!this.exists(name)) continue;
            if (typeof json[name].level === 'number')
                this.drives[name].level = clamp01(json[name].level);
            if (typeof json[name].cooldown_until === 'number')
                this.drives[name].cooldown_until = json[name].cooldown_until;
            if (typeof json[name].alarm === 'number')
                this.drives[name].alarm = clamp01(json[name].alarm);
        }
    }
}
