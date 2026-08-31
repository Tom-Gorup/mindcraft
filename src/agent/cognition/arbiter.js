// Pure goal arbitration: pick which drive to pursue, with hysteresis so the
// agent doesn't thrash between drives of similar urgency.

// urgencies: output of DriveState.getUrgencies() (sorted or not).
// current_name: drive currently being pursued, or null.
// Returns a drive name, or null if nothing is urgent enough to act on
// (contentment — the agent idles and lets ambient modes/decay take over).
export function selectDrive(urgencies, current_name = null, opts = {}) {
    const { switch_margin = 0.1, min_urgency = 0.25 } = opts;
    const eligible = urgencies
        .filter(u => !u.on_cooldown && u.urgency >= min_urgency)
        .sort((a, b) => b.urgency - a.urgency);
    if (eligible.length === 0)
        return null;
    const top = eligible[0];
    if (current_name) {
        const current = eligible.find(u => u.name === current_name);
        // stick with the current drive unless another beats it by a clear margin
        if (current && top.urgency - current.urgency < switch_margin)
            return current.name;
    }
    return top.name;
}
