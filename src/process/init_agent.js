import { Agent } from '../agent/agent.js';
import { serverProxy } from '../agent/mindserver_proxy.js';
import yargs from 'yargs';

const args = process.argv.slice(2);
if (args.length < 1) {
    console.log('Usage: node init_agent.js -n <agent_name> -p <port> -l <load_memory> -m <init_message> -c <count_id>');
    process.exit(1);
}

const argv = yargs(args)
    .option('name', {
        alias: 'n',
        type: 'string',
        description: 'name of agent'
    })
    .option('load_memory', {
        alias: 'l',
        type: 'boolean',
        description: 'load agent memory from file on startup'
    })
    .option('init_message', {
        alias: 'm',
        type: 'string',
        description: 'automatically prompt the agent on startup'
    })
    .option('count_id', {
        alias: 'c',
        type: 'number',
        default: 0,
        description: 'identifying count for multi-agent scenarios',
    })
    .option('port', {
        alias: 'p',
        type: 'number',
        description: 'port of mindserver'
    })
    .argv;

// Last-resort net for a 24/7 run. Mineflayer, pathfinder and the model
// providers all produce promises the agent deliberately does not await, and
// since Node 15 an unhandled rejection terminates the process — one failed
// pathfinder call at 3am would otherwise end the simulation. Log and continue;
// only give up if failures arrive faster than the agent can absorb them.
let recent_faults = 0;
setInterval(() => { recent_faults = 0; }, 60000).unref?.();

function survive(kind, err) {
    console.error(`${kind}:`, err?.stack || err?.message || err);
    if (++recent_faults > 20) {
        console.error('Too many unhandled faults in one minute; restarting the agent process.');
        process.exit(1);
    }
}

process.on('unhandledRejection', (err) => survive('Unhandled promise rejection', err));
process.on('uncaughtException', (err) => survive('Uncaught exception', err));

(async () => {
    try {
        console.log('Connecting to MindServer');
        await serverProxy.connect(argv.name, argv.port);
        console.log('Starting agent');
        const agent = new Agent();
        serverProxy.setAgent(agent);
        // stopAgent/forceRestart/shutdown all send SIGINT; without a handler Node
        // kills instantly and every throttled store loses its pending write.
        for (const sig of ['SIGINT', 'SIGTERM']) {
            process.on(sig, () => {
                console.log(`Received ${sig}, shutting down cleanly...`);
                try { agent.cleanKill(`Received ${sig}.`, 0); }
                catch { process.exit(0); }
            });
        }
        await agent.start(argv.load_memory, argv.init_message, argv.count_id);
    } catch (error) {
        console.error('Failed to start agent process:');
        console.error(error.message);
        console.error(error.stack);
        process.exit(1);
    }
})();
