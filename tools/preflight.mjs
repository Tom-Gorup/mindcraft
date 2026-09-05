// Pre-launch check. Verifies the things that actually stop a first run, in the
// order you hit them, and says what to do about each.
//
//   node tools/preflight.mjs
//
// Exits non-zero if anything is a hard blocker. Read-only: it opens a TCP
// connection to the Minecraft server and touches nothing else.
import { readFileSync, existsSync } from 'fs';
import net from 'net';
import settings from '../settings.js';
import { getCommandDocs } from '../src/agent/commands/index.js';

// Reproduce exactly what the agent will send: settings.blocked_actions plus
// whatever the feature flags block.
function blockedActions() {
    const blocked = [...(settings.blocked_actions || [])];
    if (!settings.use_social) blocked.push('!offerTrade', '!acceptTrade', '!declineTrade');
    if (!settings.use_cognition) blocked.push('!stepDone', '!stepFailed');
    return blocked;
}

const results = [];
const ok = (name, detail) => results.push({ level: 'ok', name, detail });
const warn = (name, detail, fix) => results.push({ level: 'warn', name, detail, fix });
const fail = (name, detail, fix) => results.push({ level: 'fail', name, detail, fix });

// ---- node ----
const major = Number(process.versions.node.split('.')[0]);
if (major >= 18 && major <= 20)
    ok('Node version', `v${process.versions.node}`);
else if (major > 20)
    warn('Node version', `v${process.versions.node} is outside the supported v18-v20 range`,
        'Fine while allow_vision and render_bot_view are both false — the gl native module is '
        + 'only reached through the lazily-imported vision path. Turn either on and you will '
        + 'need Node 18 or 20.');
else
    fail('Node version', `v${process.versions.node} is too old`, 'Install Node 18 or 20.');

// ---- api key ----
let keys = {};
if (existsSync('./keys.json')) {
    try { keys = JSON.parse(readFileSync('./keys.json', 'utf8')); }
    catch (e) { fail('keys.json', 'present but not valid JSON', e.message); }
}
// Which key matters depends on the providers the profiles actually name.
const PREFIX_TO_KEY = {
    anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY',
    mistral: 'MISTRAL_API_KEY', groq: 'GROQCLOUD_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
    openrouter: 'OPENROUTER_API_KEY', xai: 'XAI_API_KEY', novita: 'NOVITA_API_KEY',
};
function providerOf(spec) {
    const name = typeof spec === 'string' ? spec : spec?.model ?? '';
    const api = typeof spec === 'object' && spec?.api ? spec.api : null;
    if (api) return api;
    if (name.includes('/')) return name.split('/')[0];      // "ollama/llama3"
    if (name.startsWith('claude')) return 'anthropic';
    if (name.startsWith('gpt') || name.startsWith('o1')) return 'openai';
    if (name.startsWith('gemini')) return 'gemini';
    return null;
}

// ---- profiles ----
const needed = new Set();
const models = new Set();
for (const path of settings.profiles) {
    if (!existsSync(path)) {
        fail('Profile', `${path} does not exist`, 'Fix the path in settings.js "profiles".');
        continue;
    }
    let p;
    try { p = JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { fail('Profile', `${path} is not valid JSON`, e.message); continue; }
    if (!p.name) { fail('Profile', `${path} has no "name"`, 'Add a "name" field.'); continue; }
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(p.name))
        fail('Profile', `"${p.name}" is not a legal agent name`, '3-16 alphanumeric/underscore characters.');
    ok('Profile', `${path} -> agent "${p.name}"`);

    for (const spec of [p.model, p.code_model, p.vision_model, ...Object.values(p.tiers || {})]) {
        if (!spec) continue;
        models.add(typeof spec === 'string' ? spec : spec.model);
        const prov = providerOf(spec);
        const keyName = PREFIX_TO_KEY[prov];
        if (keyName) needed.add(keyName);
    }
}

for (const keyName of needed) {
    const val = keys[keyName] || process.env[keyName];
    if (val) ok('API key', `${keyName} is set (${String(val).length} chars)`);
    else fail('API key', `${keyName} is not set`,
        `Put it in keys.json, or export ${keyName}=... . Without it the agent fails at boot.`);
}
if (needed.size === 0) ok('API key', 'no keyed provider in use (local models only)');

// ---- tier routing: what will actually serve each kind of call ----
//
// The question this answers is "will it use my GPU?", and until now the only
// ways to find out were to enable log_routing (a line per call) or to watch the
// local-share tile move — both of which require having already paid for calls.
{
    const prof = JSON.parse(readFileSync(settings.profiles[0], 'utf8'));
    const tiers = prof.tiers || null;
    const TIER_NAMES = ['reflex', 'chat', 'plan', 'reflect', 'code', 'vision'];
    if (!tiers) {
        warn('Tier routing', `${prof.name}: no "tiers" block — every tier uses ${prof.model?.model ?? prof.model}`,
            'Local models are configured per tier. Without this block nothing runs on Ollama\n'
            + '     except embeddings. Add "tiers" to the profile, or use Configure in the dashboard.');
    } else {
        const localTiers = TIER_NAMES.filter(t => String(tiers[t] ?? '').startsWith('ollama'));
        for (const t of TIER_NAMES) {
            const spec = tiers[t];
            if (!spec) continue;
            const isLocal = String(spec).startsWith('ollama');
            ok('Tier routing', `${t.padEnd(7)} ${isLocal ? 'LOCAL' : ' api '}  ${spec}`);
        }
        if (localTiers.length === 0)
            warn('Tier routing', 'no tier is set to a local model', 'Every call will be billed.');
        else
            ok('Tier routing', `${localTiers.length} tier(s) on Ollama: ${localTiers.join(', ')}`);
    }
    const emb = prof.embedding;
    if (String(emb).startsWith('ollama'))
        ok('Embeddings', `${emb} (local)`);
    else
        warn('Embeddings', `${emb ?? 'unset'} — not local`,
            'Embeddings are the highest-volume call. "ollama/embeddinggemma" is the cheap win.');
}

// ---- Ollama reachability, if any local model is in use ----
//
// A wrong address or an unpulled model currently surfaces as a failed call
// mid-run, after the agent has already joined the world. Ask the server up
// front instead: it answers in milliseconds and lists exactly what it has.
const localModels = [...models].filter(m => providerOf(m) === 'ollama')
    .map(m => String(m).includes('/') ? String(m).split('/').slice(1).join('/') : null)
    .filter(Boolean);
const ollamaUrl = settings.ollama_url || 'http://127.0.0.1:11434';

if (localModels.length || String(settings.profiles?.[0] ?? '').includes('homelab')) {
    try {
        const ctl = AbortSignal.timeout(4000);
        const res = await fetch(`${ollamaUrl}/api/tags`, { signal: ctl });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const have = (body.models ?? []).map(m => m.name);
        ok('Ollama', `reachable at ${ollamaUrl} (${have.length} model${have.length === 1 ? '' : 's'})`);

        for (const want of localModels) {
            // Ollama reports "qwen2.5:7b"; a profile may say "qwen2.5" and get
            // the latest tag, so match on the base name too.
            const base = want.split(':')[0];
            const hit = have.find(h => h === want || h.split(':')[0] === base);
            if (hit) ok('Ollama model', `"${want}" is pulled (${hit})`);
            else fail('Ollama model', `"${want}" is not on ${ollamaUrl}`,
                `Pull it there:  ollama pull ${want}\n     Available: ${have.join(', ') || '(none)'}`);
        }
    } catch (err) {
        const why = err.name === 'TimeoutError' ? 'timed out' : (err.message || err);
        fail('Ollama', `cannot reach ${ollamaUrl} (${why})`,
            'Check the address in settings.local.json, that Ollama is running, and that it\n'
            + '     listens on the network rather than loopback:\n'
            + '       OLLAMA_HOST=0.0.0.0:11434 ollama serve\n'
            + '     (a default install binds 127.0.0.1 and refuses LAN connections)');
    }
}

// ---- pricing coverage, so the cost readout is not silently zero ----
const { priceFor } = await import('../src/models/metering.js');
for (const m of models) {
    const prov = providerOf(m);
    if (prov === 'ollama' || prov === 'lmstudio' || prov === 'vllm') continue;
    const p = priceFor(m);
    if (p.in === 0 && p.out === 0)
        warn('Cost estimate', `no price entry for "${m}"`,
            'It will be tallied but reported as $0.00, which reads as free. Add it to PRICES in src/models/metering.js.');
}

// ---- prompt caching ----
const { minCacheableChars, cacheFloorTokens, CACHE_BOUNDARY } = await import('../src/models/cache.js');
const anthropic = [...models].filter(m => String(m).startsWith('claude'));
if (anthropic.length) {
    const dflt = JSON.parse(readFileSync('./profiles/defaults/_default.json', 'utf8'));
    if (!dflt.conversing?.includes(CACHE_BOUNDARY)) {
        warn('Prompt caching', 'the conversing template has no cache boundary',
            'Every call pays full input price.');
    } else {
        // Actually build the prefix and check it, rather than warning
        // unconditionally. The old version divided by a hardcoded 4.2 and
        // reported a "3413-token floor" for a model whose floor is 4096.
        const dfl = JSON.parse(readFileSync('./profiles/defaults/_default.json', 'utf8'));
        for (const m of anthropic) {
            const prof = JSON.parse(readFileSync(settings.profiles[0], 'utf8'));
            const examples = (prof.conversation_examples || dfl.conversation_examples || [])
                .map(c => c.map(x => `${x.role}: ${x.content}`).join('\n')).join('\n\n');
            const filled = (prof.conversing || dfl.conversing)
                .replaceAll('$NAME', prof.name || 'Agent')
                .replaceAll('$COMMAND_DOCS', getCommandDocs({ blocked_actions: blockedActions() }))
                .replaceAll('$STATIC_EXAMPLES', examples);
            const prefix = filled.substring(0, filled.indexOf(CACHE_BOUNDARY));
            const floor = cacheFloorTokens(m);
            const est = Math.round(prefix.length / (minCacheableChars(m) / floor));
            if (prefix.length >= minCacheableChars(m))
                ok('Prompt caching', `${m}: prefix ~${est} tokens vs a ${floor}-token floor `
                    + `(+${Math.round((est / floor - 1) * 100)}%)`);
            else
                warn('Prompt caching', `${m}: prefix ~${est} tokens is under the ${floor}-token floor`,
                    'The breakpoint will be silently ignored and you pay full input price. '
                    + 'Confirm with: node tools/count_prompt_tokens.mjs');
        }
    }
}

// ---- ports ----
function portFree(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.once('listening', () => s.close(() => resolve(true)));
        s.listen(port, host);
    });
}
if (await portFree(settings.mindserver_port))
    ok('Dashboard port', `${settings.mindserver_port} is free`);
else
    fail('Dashboard port', `${settings.mindserver_port} is already in use`,
        'Stop whatever holds it, or change "mindserver_port" in settings.js.');

// ---- minecraft server ----
function reachable(host, port, timeout = 4000) {
    return new Promise((resolve) => {
        const s = new net.Socket();
        const done = (v) => { s.destroy(); resolve(v); };
        s.setTimeout(timeout);
        s.once('connect', () => done(true));
        s.once('timeout', () => done(false));
        s.once('error', () => done(false));
        s.connect(port, host);
    });
}
const { host, port } = settings;
if (host === '127.0.0.1' || host === 'localhost') {
    warn('Minecraft server', `host is ${host} — the bots will look for a server on THIS machine`,
        'If the server runs elsewhere (a Proxmox VM, another box), set "host" in settings.js to its IP.');
}
if (await reachable(host, port))
    ok('Minecraft server', `${host}:${port} is accepting connections`);
else
    fail('Minecraft server', `nothing is answering at ${host}:${port}`,
        'Check the server is running, the IP and port are right, and no firewall is in the way.');

// ---- flags worth knowing about ----
const flags = ['use_cognition', 'use_memory', 'use_social', 'use_skill_library',
    'allow_insecure_coding', 'allow_vision'].filter(f => settings[f]);
ok('Feature flags', flags.length ? flags.join(', ') : 'all off (a plain reactive chat agent)');
if (settings.allow_insecure_coding)
    warn('Security', 'allow_insecure_coding is ON',
        'Model-written JavaScript will execute on this machine. Run it in the container, not on your laptop.');

// ---- report ----
const ICON = { ok: '  OK  ', warn: ' WARN ', fail: ' FAIL ' };
console.log('\nPreflight\n');
for (const r of results) {
    console.log(`[${ICON[r.level]}] ${r.name}: ${r.detail}`);
    if (r.fix) console.log(`          ${r.fix}`);
}
const fails = results.filter(r => r.level === 'fail').length;
const warns = results.filter(r => r.level === 'warn').length;
console.log(`\n${fails} blocker(s), ${warns} warning(s).`);
console.log(fails ? 'Fix the blockers above, then run: node main.js\n'
    : 'Ready. Start with: node main.js\n');
process.exit(fails ? 1 : 0);
