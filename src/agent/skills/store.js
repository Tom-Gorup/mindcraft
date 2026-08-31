// Persistence for learned skills. One JSON file per agent
// (bots/<name>/skills/skills.json) — skill count stays small (hundreds, not
// millions), so whole-file writes are fine and keep the format inspectable.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

export class SkillStore {
    constructor(dir) {
        this.dir = dir;
        this.fp = path.join(dir, 'skills.json');
        mkdirSync(dir, { recursive: true });
    }

    // Returns {skills: [], embeddings: {name: vector}}. Corruption is not
    // fatal — a bad file logs and starts fresh rather than bricking the agent.
    load() {
        if (!existsSync(this.fp))
            return { skills: [], embeddings: {} };
        try {
            const data = JSON.parse(readFileSync(this.fp, 'utf8'));
            // skills.json holds executable code that runs without lint on the
            // direct-execution path — validate shape strictly on the way in
            const valid = (s) => s
                && typeof s.name === 'string' && /^[a-z0-9_]{1,45}$/.test(s.name)
                && typeof s.code === 'string' && s.code.length > 0 && s.code.length <= 20000
                && (s.task === undefined || (typeof s.task === 'string' && s.task.length <= 500))
                && (s.docstring === undefined || (typeof s.docstring === 'string' && s.docstring.length <= 500));
            const raw = Array.isArray(data.skills) ? data.skills : [];
            const dropped = raw.length - raw.filter(valid).length;
            if (dropped > 0)
                console.warn(`SkillStore: dropped ${dropped} malformed skill entr${dropped === 1 ? 'y' : 'ies'}.`);
            const skills = raw.filter(valid)
                .map(s => ({
                    ...s,
                    // hand-edited/legacy entries must not NaN-poison the stats
                    uses: Number(s.uses) || 0,
                    successes: Number(s.successes) || 0,
                    failures: Number(s.failures) || 0,
                    last_used: Number(s.last_used) || 0,
                }));
            return {
                skills,
                embeddings: data.embeddings && typeof data.embeddings === 'object' ? data.embeddings : {},
            };
        } catch (err) {
            console.error('SkillStore: failed to load skills.json, starting fresh:', err.message || err);
            return { skills: [], embeddings: {} };
        }
    }

    persist(skills, embeddings) {
        try {
            // atomic: a crash mid-write must not truncate the whole library
            const tmp = this.fp + '.tmp';
            writeFileSync(tmp, JSON.stringify({ skills, embeddings }));
            renameSync(tmp, this.fp);
        } catch (err) {
            console.error('SkillStore: failed to persist:', err.message || err);
        }
    }
}
