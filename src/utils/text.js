export function stringifyTurns(turns) {
    let res = '';
    for (let turn of turns) {
        if (turn.role === 'assistant') {
            res += `\nYour output:\n${turn.content}`;
        } else if (turn.role === 'system') {
            res += `\nSystem output: ${turn.content}`;
        } else {
            res += `\nUser input: ${turn.content}`;
        
        }
    }
    return res.trim();
}

export function toSinglePrompt(turns, system=null, stop_seq='***', model_nickname='assistant') {
    let prompt = system ? `${system}${stop_seq}` : '';
    let role = '';
    turns.forEach((message) => {
        role = message.role;
        if (role === 'assistant') role = model_nickname;
        prompt += `${role}: ${message.content}${stop_seq}`;
    });
    if (role !== model_nickname) // if the last message was from the user/system, add a prompt for the model. otherwise, pretend we are extending the model's own message
        prompt += model_nickname + ": ";
    return prompt;
}

function _getWords(text) {
    return text.replace(/[^a-zA-Z ]/g, '').toLowerCase().split(' ');
}

export function wordOverlapScore(text1, text2) {
    const words1 = _getWords(text1);
    const words2 = _getWords(text2);
    const intersection = words1.filter(word => words2.includes(word));
    return intersection.length / (words1.length + words2.length - intersection.length);
}

// ensures stricter turn order and roles:
// - system messages are treated as user messages and prefixed with SYSTEM:
// - combines repeated messages from users
// - separates repeat assistant messages with filler user messages
// Normalize a turn list into the shape strict providers demand: alternating
// roles, a leading user message, and — critically for Anthropic, which returns
// a 400 rather than ignoring them — no empty text blocks anywhere.
export function strictFormat(turns) {
    let prev_role = null;
    let messages = [];
    // NOTE: a fresh object each time. Pushing one shared filler at several
    // indices would let a later append mutate all of them at once.
    const filler = () => ({ role: 'user', content: '_' });
    for (let msg of turns) {
        if (typeof msg.content === 'string')  {
            msg.content = msg.content.trim();
            // The default persona tells the bot to answer with a bare tab when
            // it has nothing to say, and command results can come back blank.
            // Either one becomes an empty text block, which Anthropic rejects
            // outright — drop the turn instead of failing the whole request.
            if (msg.content.length === 0) continue;
        }
        if (msg.role === 'system') {
            msg.role = 'user';
            msg.content = 'SYSTEM: ' + msg.content;
        }
        if (msg.role === prev_role && msg.role === 'assistant') {
            // insert empty user message to separate assistant messages
            messages.push(filler());
            messages.push(msg);
        }
        else if (msg.role === prev_role) {
            // combine new message with previous message instead of adding a new one
            messages[messages.length-1].content += '\n' + msg.content;
        }
        else {
            messages.push(msg);
        }
        prev_role = msg.role;
        
    }
    if (messages.length > 0 && messages[0].role !== 'user') {
        messages.unshift(filler()); // anthropic requires a user message to start
    }
    if (messages.length === 0) {
        messages.push(filler());
    }
    return messages;
}