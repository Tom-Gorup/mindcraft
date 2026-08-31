// Append-only JSONL persistence for the memory stream. One directory per
// agent (bots/<name>/memory/): events.jsonl is the source of truth,
// embeddings.jsonl is a cache keyed by event id (safe to delete — vectors
// are recomputed lazily for events that need them).
import { appendFileSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
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

    // Rewrite embeddings.jsonl keeping only vectors still referenced in RAM.
    // Without this the file grows without bound (each line is a full vector,
    // ~15KB at 768 dims) and is read+parsed in full on every restart — on a
    // 24/7 run that becomes a multi-GB heap spike at boot.
    compactEmbeddings(live_embeddings) {
        try {
            const tmp = this.embeddings_fp + '.tmp';
            let out = '';
            for (const [id, v] of live_embeddings)
                out += JSON.stringify({ id, v }) + '\n';
            writeFileSync(tmp, out);
            renameSync(tmp, this.embeddings_fp);
        } catch (err) {
            console.error('MemoryStore: embedding compaction failed:', err.message || err);
        }
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
        let raw;
        try {
            raw = readFileSync(fp, 'utf8');
        } catch (err) {
            // an unreadable or over-large store must degrade, not kill the agent
            console.error(`MemoryStore: could not read ${fp}, continuing without it:`, err.message || err);
            return [];
        }
        const out = [];
        for (const line of raw.split('\n')) {
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
