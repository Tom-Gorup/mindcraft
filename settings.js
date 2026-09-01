// Per-machine configuration lives in settings.local.json, NOT in this file.
// This file is tracked in git, but host, port and feature flags differ on every
// machine — so editing it directly makes every `git pull` a merge conflict on
// your own config. Anything in settings.local.json (gitignored) overrides the
// defaults below. See settings.local.example.json.
import { readFileSync, existsSync } from 'fs';

const settings = {
    "minecraft_version": "auto", // or specific version like "1.21.6"
    // These are DEFAULTS. Put your machine's real values in settings.local.json
    // (gitignored) — editing them here means your private network config gets
    // committed, and every git pull becomes a conflict on your own settings.
    "host": "127.0.0.1", // override in settings.local.json, not here
    "port": 55916, // override in settings.local.json, not here
    "auth": "offline", // or "microsoft"
    "world": "", // optional label for this Minecraft world; groups agents in the dashboard and reports. Defaults to host:port

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": true, // opens UI in browser on startup
    
    "base_profile": "assistant", // survival, assistant, creative, or god_mode
    // Start agents automatically when the server boots.
    // Leave this true: a crashed agent should come back. An agent you stop
    // from the dashboard is recorded as deliberately stopped and stays down
    // across restarts regardless, so you rarely need to turn this off.
    // Set false to bring the server and dashboard up with nothing joining.
    "autostart_agents": true,

    "profiles": [
        "./profiles/first_run.json", // one Haiku agent, no feature flags — start here
        // "./andy.json",
        // "./profiles/gpt.json",
        // "./profiles/claude.json",
        // "./profiles/gemini.json",
        // "./profiles/llama.json",
        // "./profiles/qwen.json",
        // "./profiles/grok.json",
        // "./profiles/mistral.json",
        // "./profiles/deepseek.json",
        // "./profiles/mercury.json",
        // "./profiles/andy-4.json", // Supports up to 75 messages!
        // "./profiles/homelab.json", // local-first tier routing for 24/7 runs
        // "./profiles/wilbur.json",  // explorer personality (drives + social)
        // "./profiles/greta.json",   // hoarder personality; conflicts with Wilbur

        // using more than 1 profile requires you to /msg each bot indivually
        // individual profiles override values from the base profile
    ],

    "use_cognition": true, // autonomous drive-based cognition loop (drives -> goals -> plans). experimental
    "use_memory": false, // long-term event memory with retrieval and reflection. experimental
    "use_skill_library": false, // learn/reuse/compose successful newAction code. requires allow_insecure_coding. experimental
    "use_social": false, // per-peer relationships, gossip, and trade. experimental
    "load_memory": false, // load memory from previous session
    "init_message": "Respond with hello world and your name", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": false,
    // allows all bots to speak through text-to-speech. 
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech. 
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    "render_bot_view": false, // show bot's view in browser at localhost:3000, 3001...

    "allow_insecure_coding": false, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": false, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel",
        // !restart kills the agent process. It exists for a human to trigger, but it is in the
        // command docs, so a stuck model reaches for it as an escape hatch — observed twice in
        // five minutes. Each one costs a full reconnect and resets the in-memory meter.
        "!restart"] , // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": 5, // minutes code is allowed to run. -1 for no timeout (not advised for 24/7 runs)
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 15, // max number of messages to keep in context
    "num_examples": 2, // number of examples to give to the model
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    "show_command_syntax": "full", // "full", "shortened", or "none"
    "narrate_behavior": true, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 30, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 0, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.
  
    "log_all_prompts": false, // log ALL prompts to file
    "log_routing": false, // log every model call's tier, provider, and token estimate
};

// ---- overlay: defaults < settings.local.json < SETTINGS_JSON env ----
const LOCAL_SETTINGS = './settings.local.json';
if (existsSync(LOCAL_SETTINGS)) {
    try {
        const local = JSON.parse(readFileSync(LOCAL_SETTINGS, 'utf8'));
        for (const [k, v] of Object.entries(local)) {
            if (k.startsWith('//')) continue;   // allow comment keys
            settings[k] = v;
        }
        console.log(`Loaded local overrides from ${LOCAL_SETTINGS}: ${Object.keys(local).filter(k => !k.startsWith('//')).join(', ')}`);
    } catch (err) {
        // Loud, not silent: a typo here changes which server the bots join.
        console.error(`\n${LOCAL_SETTINGS} exists but could not be read: ${err.message}`);
        console.error('Falling back to the defaults in settings.js. Fix the JSON and restart.\n');
    }
}

export default settings;
