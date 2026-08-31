// LLM-backed goal generation and task planning. Parsing helpers are exported
// standalone so they can be unit-tested without an agent.

// Extract the first JSON object from a model response that may contain
// <think> blocks, prose, or a ```json codeblock.
export function parseJsonResponse(res) {
    if (typeof res !== 'string') return null;
    let text = res;
    if (text.includes('</think>'))
        text = text.split('</think>').pop();
    const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (block)
        text = block[1];
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start)
        return null;
    try {
        return JSON.parse(text.substring(start, end + 1));
    } catch {
        // first..last braces over-reaches when the model appends prose that
        // happens to contain a brace, or emits a second object. Smaller models
        // do both often enough to matter, so fall back to the first balanced
        // object instead of giving up.
        const balanced = firstBalancedObject(text, start);
        if (balanced === null) return null;
        try {
            return JSON.parse(balanced);
        } catch {
            return null;
        }
    }
}

// Scan from `start` tracking brace depth, ignoring braces inside strings, and
// return the first complete {...} span.
function firstBalancedObject(text, start) {
    let depth = 0, in_string = false, escaped = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (in_string) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') in_string = false;
            continue;
        }
        if (c === '"') in_string = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return text.substring(start, i + 1);
    }
    return null;
}

export function parseGoalResponse(res) {
    const data = parseJsonResponse(res);
    if (!data || typeof data.goal !== 'string' || data.goal.trim().length === 0)
        return null;
    return {
        goal: data.goal.trim(),
        reason: typeof data.reason === 'string' ? data.reason.trim() : '',
    };
}

export function parsePlanResponse(res) {
    const data = parseJsonResponse(res);
    if (!data || !Array.isArray(data.steps))
        return null;
    const steps = data.steps
        .filter(s => typeof s === 'string' && s.trim().length > 0)
        .map(s => s.trim());
    return steps.length > 0 ? steps : null;
}

// Render a plan with progress markers for prompts and the dashboard.
export function formatPlan(steps, step_index) {
    let text = '';
    for (let i = 0; i < steps.length; i++) {
        let marker = ' ';
        if (i < step_index) marker = 'done';
        else if (i === step_index) marker = 'CURRENT';
        text += `${i + 1}. [${marker}] ${steps[i]}\n`;
    }
    return text.trim();
}

export class Planner {
    constructor(agent) {
        this.agent = agent;
    }

    // Returns {goal, reason} or null on parse/model failure.
    async generateGoal(drive_name, drive_state_text) {
        const res = await this.agent.prompter.promptGoalGeneration(drive_name, drive_state_text);
        return parseGoalResponse(res);
    }

    // Returns array of step strings or null. failure_context is included when replanning.
    async makePlan(goal, failure_context = '') {
        const res = await this.agent.prompter.promptTaskPlanning(goal, failure_context);
        return parsePlanResponse(res);
    }
}
