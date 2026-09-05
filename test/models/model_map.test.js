import test from 'node:test';
import assert from 'node:assert/strict';
import { baseUrlFor } from '../../src/models/_model_map.js';
import { setSettings } from '../../src/agent/settings.js';

// ---- local provider base URL ----
//
// A LAN address must be settable without editing a tracked file. Profiles are
// tracked; settings.local.json is not, and a LAN address committed to a public
// repo is a leak this project has already had once.

test('a local provider takes its base url from settings', () => {
    setSettings({ ollama_url: 'http://10.0.0.5:11434' });
    assert.equal(baseUrlFor('ollama'), 'http://10.0.0.5:11434');
});

test('an explicit profile url still wins', () => {
    setSettings({ ollama_url: 'http://10.0.0.5:11434' });
    assert.equal(baseUrlFor('ollama', 'http://other:11434'), 'http://other:11434');
});

test('unset settings fall through to the provider default', () => {
    setSettings({});
    assert.equal(baseUrlFor('ollama'), undefined, 'undefined lets Ollama use 127.0.0.1');
});

// A url on a keyed provider redirects the API key and every prompt to that
// host. That must stay an explicit per-profile decision, never a global.
test('keyed providers are never given the local url', () => {
    setSettings({ ollama_url: 'http://10.0.0.5:11434' });
    for (const api of ['anthropic', 'openai', 'google'])
        assert.equal(baseUrlFor(api), undefined, `${api} must not inherit the local url`);
});
