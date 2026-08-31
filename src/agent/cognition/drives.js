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
        description: 'Explore new places, discover resources, try new things.',
    },
    social: {
        weight: 0.5,
        type: 'decay',
        decay_per_min: 0.01,
        description: 'Interact with players and other bots.',
    },
    wealth: {
        weight: 0.4,
        type: 'sensor',
        description: 'Accumulate valuable resources, tools, and equipment.',
    },
};

function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}

export class DriveState {
    // config: optional per-drive overrides from the profile's "drives" block.
    // Unknown drive names are accepted as custom decay drives.
    constructor(config = {}) {
        this.drives = {};
        const names = new Set([...Object.keys(DEFAULT_DRIVES), ...Object.keys(config)]);
        for (const name of names) {
            const def = DEFAULT_DRIVES[name] || {};
            const cfg = config[name] || {};
            this.drives[name] = {
                name,
                weight: cfg.weight ?? def.weight ?? 0.5,
                type: cfg.type ?? def.type ?? 'decay',
                decay_per_min: cfg.decay_per_min ?? def.decay_per_min ?? 0.01,
                description: cfg.description ?? def.description ?? '',
                level: clamp01(cfg.initial_level ?? 1.0),
                cooldown_until: 0,
            };
        }
    }

    exists(name) {
        return this.drives[name] != null;
    }

    update(delta_ms, sensor_levels = {}) {
        for (const d of Object.values(this.drives)) {
            if (sensor_levels[d.name] !== undefined)
                d.level = clamp01(sensor_levels[d.name]);
            else if (d.type === 'decay')
                d.level = clamp01(d.level - d.decay_per_min * (delta_ms / 60000));
        }
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

    setCooldown(name, until_ts) {
        if (this.exists(name))
            this.drives[name].cooldown_until = until_ts;
    }

    // Sorted descending by urgency. on_cooldown drives are included but flagged.
    getUrgencies(now = Date.now()) {
        return Object.values(this.drives)
            .map(d => ({
                name: d.name,
                urgency: this.urgency(d.name),
                level: d.level,
                weight: d.weight,
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
            if (u.on_cooldown) text += ' [recently failed, avoid for now]';
            text += '\n';
        }
        return text.trim();
    }

    getJson() {
        const levels = {};
        for (const d of Object.values(this.drives))
            levels[d.name] = { level: d.level, cooldown_until: d.cooldown_until };
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
        }
    }
}
