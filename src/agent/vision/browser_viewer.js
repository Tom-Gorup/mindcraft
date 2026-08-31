import settings from '../settings.js';
import prismarineViewer from 'prismarine-viewer';
const mineflayerViewer = prismarineViewer.mineflayer;

export function addBrowserViewer(bot, count_id) {
    if (!settings.render_bot_view) return;
    const port = 3000 + count_id;
    try {
        mineflayerViewer(bot, { port, firstPerson: true, });
    } catch (err) {
        // A viewer is a convenience, never a reason to lose the agent.
        console.warn(`Could not start the browser viewer on port ${port}: ${err.message || err}`);
    }
    // NOTE: prismarine-viewer keeps its http server module-local, so an
    // occupied port surfaces asynchronously as an uncaught EADDRINUSE that
    // this function cannot see. init_agent.js's process-level handler absorbs
    // it; if two agents ever share a viewer port, that is where it shows up.
}
