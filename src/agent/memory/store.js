// Append-only JSONL persistence for the memory stream. One directory per
// agent (bots/<name>/memory/): events.jsonl is the source of truth,
// embeddings.jsonl is a cache keyed by event id (safe to delete — vectors
// are recomputed lazily for events that need them).
import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

export class MemoryStore {
    constructor(dir) {
        this.dir = dir;
        this.events_fp = path.join(dir, 'events.jsonl');
        this.embeddings_fp = path.join(dir, 'embeddings.jsonl');
        mkdirSync(dir, { recursive: true });
    }

    appendEvent(event) {
        appendFileSync(this.events_fp, JSON.stringify(event) + '\n');
    }

    appendEmbedding(id, vector) {
        appendFileSync(this.embeddings_fp, JSON.stringify({ id, v: vector }) + '\n');
    }

    // Returns {events: [], embeddings: Map<id, vector>}. Corrupt lines are
    // skipped, not fatal — an append interrupted by a crash must not brick
    // the agent's memory.
    loadAll() {
        return {
            events: this._readJsonl(this.events_fp),
            embeddings: new Map(
                this._readJsonl(this.embeddings_fp)
                    .filter(r => r.id && Array.isArray(r.v))
                    .map(r => [r.id, r.v])
            ),
        };
    }

    _readJsonl(fp) {
        if (!existsSync(fp)) return [];
        const out = [];
        for (const line of readFileSync(fp, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
                out.push(JSON.parse(line));
            } catch {
                // skip corrupt line
            }
        }
        return out;
    }
}
