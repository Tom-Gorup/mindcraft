import * as Mindcraft from './src/mindcraft/mindcraft.js';
import settings from './settings.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { readFileSync } from 'fs';

function parseArguments() {
    return yargs(hideBin(process.argv))
        .option('profiles', {
            type: 'array',
            describe: 'List of agent profile paths',
        })
        .option('task_path', {
            type: 'string',
            describe: 'Path to task file to execute'
        })
        .option('task_id', {
            type: 'string',
            describe: 'Task ID to execute'
        })
        .help()
        .alias('help', 'h')
        .parse();
}
const args = parseArguments();
if (args.profiles) {
    settings.profiles = args.profiles;
}
if (args.task_path) {
    let tasks = JSON.parse(readFileSync(args.task_path, 'utf8'));
    if (args.task_id) {
        settings.task = tasks[args.task_id];
        settings.task.task_id = args.task_id;
    }
    else {
        throw new Error('task_id is required when task_path is provided');
    }
}

// these environment variables override certain settings
if (process.env.MINECRAFT_PORT) {
    settings.port = process.env.MINECRAFT_PORT;
}
if (process.env.MINDSERVER_PORT) {
    settings.mindserver_port = process.env.MINDSERVER_PORT;
}
if (process.env.PROFILES && JSON.parse(process.env.PROFILES).length > 0) {
    settings.profiles = JSON.parse(process.env.PROFILES);
}
if (process.env.INSECURE_CODING) {
    settings.allow_insecure_coding = true;
}
if (process.env.BLOCKED_ACTIONS) {
    settings.blocked_actions = JSON.parse(process.env.BLOCKED_ACTIONS);
}
if (process.env.MAX_MESSAGES) {
    settings.max_messages = process.env.MAX_MESSAGES;
}
if (process.env.NUM_EXAMPLES) {
    settings.num_examples = process.env.NUM_EXAMPLES;
}
if (process.env.LOG_ALL) {
    settings.log_all_prompts = process.env.LOG_ALL;
}
if (process.env.SETTINGS_JSON) {
    try {
        Object.assign(settings, JSON.parse(process.env.SETTINGS_JSON));
    } catch (err) {
        console.error("Failed to parse environment variable for SETTINGS_JSON:", err);
    }
}


await Mindcraft.init(false, settings.mindserver_port, settings.auto_open_ui);

// Start agents one at a time and report on each. Previously the result of
// createAgent was discarded, so an unreadable profile or a duplicate name meant
// an agent simply never appeared, with the reason buried in the boot log.
const failures = [];
for (const profile of settings.profiles) {
    let profile_json;
    try {
        profile_json = JSON.parse(readFileSync(profile, 'utf8'));
    } catch (err) {
        failures.push(`${profile}: could not be read or is not valid JSON (${err.message})`);
        continue;
    }
    settings.profile = profile_json;
    const result = await Mindcraft.createAgent(settings);
    if (!result?.success)
        failures.push(`${profile}: ${result?.error || 'unknown error'}`);
}

if (failures.length) {
    console.error(`\n${failures.length} of ${settings.profiles.length} profile(s) did not start:`);
    for (const f of failures) console.error(`  - ${f}`);
    if (failures.length === settings.profiles.length) {
        console.error('No agents started. Exiting.');
        process.exit(1);
    }
}