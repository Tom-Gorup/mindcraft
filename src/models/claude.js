import Anthropic from '@anthropic-ai/sdk';
import { strictFormat } from '../utils/text.js';
import { getKey } from '../utils/keys.js';
import { splitCachePrefix, stripBoundary, minCacheableChars } from './cache.js';

export class Claude {
    static prefix = 'anthropic';
    static supports_cache_boundary = true;
    // Only used when a profile names no model at all.
    static DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
    static _warned_no_cache = false;
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};

        let config = {};
        if (url)
            config.baseURL = url;
        
        config.apiKey = getKey('ANTHROPIC_API_KEY');

        this.anthropic = new Anthropic(config);
    }

    async sendRequest(turns, systemMessage) {
        const messages = strictFormat(turns);
        let res = null;
        this.last_usage = null;   // never let a previous call's usage be reused
        try {
            console.log(`Awaiting anthropic response from ${this.model_name}...`);
            if (!this.params.max_tokens) {
                if (this.params.thinking?.budget_tokens) {
                    this.params.max_tokens = this.params.thinking.budget_tokens + 1000;
                    // max_tokens must be greater than thinking.budget_tokens
                } else {
                    this.params.max_tokens = 4096;
                }
            }
            // Prompt caching: split the system prompt at the cache boundary and
            // mark the stable prefix (persona + command docs) as ephemeral, so
            // repeat calls within the cache window only pay for the volatile
            // tail. Below the provider minimum a breakpoint is pointless, so
            // fall back to a plain string.
            const { prefix, rest, cacheable } = splitCachePrefix(systemMessage, this.model_name);
            if (!cacheable && prefix)
                this._warnNoCache(prefix, this.model_name);
            const system = cacheable
                ? [
                    { type: 'text', text: prefix, cache_control: { type: 'ephemeral' } },
                    { type: 'text', text: rest },
                ]
                : stripBoundary(systemMessage);

            const resp = await this.anthropic.messages.create({
                model: this.model_name || Claude.DEFAULT_MODEL,
                system: system,
                messages: messages,
                ...(this.params || {})
            });

            console.log('Received.');
            // Real token counts, including cache hits — the router reads this
            // instead of estimating from string length. cache_read_input_tokens
            // being non-zero is the proof that prompt caching is working.
            this.last_usage = resp.usage ? {
                in_tokens: (resp.usage.input_tokens ?? 0)
                    + (resp.usage.cache_creation_input_tokens ?? 0)
                    + (resp.usage.cache_read_input_tokens ?? 0),
                out_tokens: resp.usage.output_tokens ?? 0,
                cache_write_tokens: resp.usage.cache_creation_input_tokens ?? 0,
                cache_read_tokens: resp.usage.cache_read_input_tokens ?? 0,
                uncached_in_tokens: resp.usage.input_tokens ?? 0,
            } : null;
            // get first content of type text
            const textContent = resp.content.find(content => content.type === 'text');
            if (textContent) {
                res = textContent.text;
            } else {
                console.warn('No text content found in the response.');
                res = 'No response from Claude.';
            }
        }
        catch (err) {
            // Surface the failure to the router so it is metered as an error
            // and can fall back. Returning prose here would be indistinguishable
            // from a real answer.
            const status = err?.status ?? err?.response?.status;
            const kind = err?.error?.error?.type ?? err?.name ?? 'error';
            const detail = err?.error?.error?.message ?? err?.message ?? String(err);
            if (status === 401 || kind === 'authentication_error')
                throw new Error(`Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY in keys.json or the environment. [${detail}]`);
            if (status === 404 || kind === 'not_found_error')
                throw new Error(`Anthropic does not know the model '${this.model_name}' (404). Check the model id in your profile. [${detail}]`);
            if (status === 429)
                throw new Error(`Anthropic rate limit hit (429) on ${this.model_name}. [${detail}]`);
            throw new Error(`Anthropic request failed${status ? ` (${status})` : ''} on ${this.model_name}: ${detail}`);
        }
        return res;
    }

    // A prefix under the model's floor is not an error — the request succeeds,
    // it just never caches, and the only symptom is the bill. Say so once, with
    // the numbers and the remedy, rather than letting it pass in silence.
    _warnNoCache(prefix, model_name) {
        if (Claude._warned_no_cache) return;
        Claude._warned_no_cache = true;
        const floor = Math.round(minCacheableChars(model_name) / 4.2);
        const have = Math.round(prefix.length / 4.2);
        console.warn(
            `\nPrompt caching is OFF for ${model_name}: the cacheable prefix is ~${have} tokens `
            + `but this model needs ${floor}.\n`
            + `  Every call will pay full input price. Options:\n`
            + `  - turn on a feature flag (use_cognition / use_social add commands to the cached prefix), or\n`
            + `  - use a Sonnet/Opus model, whose floor is 1024 tokens, or\n`
            + `  - lengthen the persona text ahead of the boundary in profiles/defaults/_default.json.\n`
            + `  Check with: node tools/measure_prompt.mjs\n`);
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        const imageMessages = [...turns];
        imageMessages.push({
            role: "user",
            content: [
                {
                    type: "text",
                    text: systemMessage
                },
                {
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: "image/jpeg",
                        data: imageBuffer.toString('base64')
                    }
                }
            ]
        });

        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Claude.');
    }
}
