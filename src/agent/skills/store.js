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
            const skills = (Array.isArray(data.skills) ? data.skills.filter(s => s && s.name && s.code) : [])
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
