import { strictFormat } from '../utils/text.js';

export class Ollama {
    static prefix = 'ollama';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.url = url || 'http://127.0.0.1:11434';
        this.chat_endpoint = '/api/chat';
        this.embedding_endpoint = '/api/embed';
    }

    async sendRequest(turns, systemMessage) {
        let model = this.model_name || 'sweaterdog/andy-4:micro-q8_0';
        let messages = strictFormat(turns);
        messages.unshift({ role: 'system', content: systemMessage });
        const maxAttempts = 5;
        let attempt = 0;
        let finalRes = null;

        while (attempt < maxAttempts) {
            attempt++;
            console.log(`Awaiting local response... (model: ${model}, attempt: ${attempt})`);
            let res = null;
            try {
                let apiResponse = await this.send(this.chat_endpoint, {
                    model: model,
                    messages: messages,
                    stream: false,
                    ...(this.params || {})
                });
                if (apiResponse) {
                    res = apiResponse['message']['content'];
                } else {
                    // Throw rather than returning a sentinel string: a caller
                    // that gets prose back cannot tell a dead endpoint from a
                    // real answer, so the router would meter an outage as a
                    // successful free local call and never fall back.
                    throw new Error(`No response from Ollama at ${this.url} (model '${model}' — is Ollama running and the model pulled?)`);
                }
            } catch (err) {
                if (err.message.toLowerCase().includes('context length') && turns.length > 1) {
                    console.log('Context length exceeded, trying again with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage);
                }
                // surface transport/model failures to the router so they are
                // metered as errors and can fall back to another tier
                throw err;
            }

            const hasOpenTag = res.includes("<think>");
            const hasCloseTag = res.includes("</think>");

            if ((hasOpenTag && !hasCloseTag)) {
                console.warn("Partial <think> block detected. Re-generating...");
                if (attempt < maxAttempts) continue;
            }
            if (hasCloseTag && !hasOpenTag) {
                res = '<think>' + res;
            }
            if (hasOpenTag && hasCloseTag) {
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            }
            finalRes = res;
            break;
        }

        if (finalRes == null) {
            console.warn("Could not get a valid response after max attempts.");
            finalRes = 'I thought too hard, sorry, try again.';
        }
        return finalRes;
    }

    async embed(text) {
        let model = this.model_name || 'embeddinggemma';
        let body = { model: model, input: text };
        let res = await this.send(this.embedding_endpoint, body);
        if (!res)
            throw new Error('No response from Ollama embedding endpoint.');
        // /api/embed returns {embeddings: [[...]]}; legacy /api/embeddings returned {embedding: [...]}
        const vec = res['embeddings']?.[0] ?? res['embedding'];
        if (!Array.isArray(vec))
            throw new Error(`Ollama embedding response contained no vector (model '${model}' — is it pulled?).`);
        return vec;
    }

    async send(endpoint, body) {
        const url = new URL(endpoint, this.url);
        let method = 'POST';
        let headers = new Headers();
        const request = new Request(url, { method, headers, body: JSON.stringify(body) });
        let data = null;
        try {
            const res = await fetch(request);
            if (res.ok) {
                data = await res.json();
            } else {
                throw new Error(`Ollama Status: ${res.status}`);
            }
        } catch (err) {
            console.error('Failed to send Ollama request.');
            console.error(err);
        }
        return data;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "text", text: systemMessage },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                    }
                }
            ]
        });
        
        return this.sendRequest(imageMessages, systemMessage);
    }
}
