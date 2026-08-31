// Persistence for learned skills. One JSON file per agent
// (bots/<name>/skills/skills.json) — skill count stays small (hundreds, not
// millions), so whole-file writes are fine and keep the format inspectable.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
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
            return {
                skills: Array.isArray(data.skills) ? data.skills.filter(s => s && s.name && s.code) : [],
                embeddings: data.embeddings && typeof data.embeddings === 'object' ? data.embeddings : {},
            };
        } catch (err) {
            console.error('SkillStore: failed to load skills.json, starting fresh:', err.message || err);
            return { skills: [], embeddings: {} };
        }
    }

    persist(skills, embeddings) {
        try {
            writeFileSync(this.fp, JSON.stringify({ skills, embeddings }));
        } catch (err) {
            console.error('SkillStore: failed to persist:', err.message || err);
        }
    }
}
