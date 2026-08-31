#!/usr/bin/env python3
"""Build a self-contained offline demo of the mindserver dashboard.

The dashboard normally needs a live mindserver and a Minecraft world. This
script copies the public assets to a temp directory, stubs socket.io with a
fixture-serving fake, and writes demo.html so the UI can be opened directly in
a browser (or screenshotted headlessly) with realistic data in it.

    python3 tools/ui_demo.py [outdir]        # default: $TMPDIR/mindcraft-demo
    open <outdir>/demo.html                  # Agents view
    open <outdir>/demo.html#sim              # Sim view
    open <outdir>/demo.html#reports          # Reports view

This is a design and review aid — it is not shipped or served by the app.
"""
import json
import os
import random
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, '..', 'src', 'mindcraft', 'public')

SOCKET_STUB = """<script>
// --- offline demo stub: a socket that answers from fixture data ---
window.io = function () {
  const handlers = {};
  const api = {
    on(ev, fn) { handlers[ev] = fn; return api; },
    emit(ev, a, b) {
      const cb = typeof a === 'function' ? a : (typeof b === 'function' ? b : null);
      if (ev === 'get-settings' && cb) cb({ settings: { render_bot_view: false } });
      if (ev === 'list-runs' && cb) cb({ runs: window.__RUNS, active: window.__RUNS[0].id });
      if (ev === 'get-report' && cb) cb({ success: true, report: window.__REPORT, export_path: 'runs/wilbur-vs-greta-1/events.jsonl' });
      return api;
    },
    _fire(ev) { const h = handlers[ev]; if (h) h.apply(null, [].slice.call(arguments, 1)); },
  };
  window.__sock = api;
  return api;
};
</script>"""

AGENTS = [
    {"name": "Wilbur", "in_game": True, "viewerPort": 3000, "socket_connected": True, "world": "lan.local:25565"},
    {"name": "Greta", "in_game": True, "viewerPort": 3001, "socket_connected": True, "world": "lan.local:25565"},
    {"name": "Otto", "in_game": False, "viewerPort": 3002, "socket_connected": False, "world": "lan.local:25566"},
]

STATES = {
    "Wilbur": {
        "gameplay": {"position": {"x": 118.4, "y": 71, "z": -402.9}, "health": 17, "hunger": 13,
                     "biome": "birch_forest", "gamemode": "survival", "timeLabel": "Afternoon"},
        "action": {"current": "Goal: stock up on iron before dark", "kind": "thinking", "isIdle": False},
        "inventory": {"counts": {"oak_log": 34, "iron_ore": 12, "cooked_beef": 6, "torch": 21,
                                 "stone_pickaxe": 1, "bread": 3}, "stacksUsed": 9, "totalSlots": 36,
                      "equipment": {"helmet": "iron_helmet", "chestplate": "leather_chestplate",
                                    "leggings": None, "boots": "iron_boots", "mainHand": "stone_pickaxe"}},
        "cognition": {"enabled": True, "state": "pursuing", "goal": "Stock up on iron before dark",
                      "drive": "wealth", "step": {"index": 2, "total": 4, "text": "Mine the iron vein spotted at y=48"},
                      "last_thought": "Greta has been circling the same ravine. I should hurry.",
                      "urgencies": [{"name": "wealth", "urgency": 0.81}, {"name": "safety", "urgency": 0.44},
                                    {"name": "food", "urgency": 0.36}, {"name": "curiosity", "urgency": 0.22},
                                    {"name": "social", "urgency": 0.12, "on_cooldown": True}]},
        "memory": {"enabled": True, "events": 1284, "beliefs": 17},
        "skills": {"enabled": True, "count": 9, "total_uses": 63},
        "economics": {"local_share": 0.0, "totals": {"calls": 812, "in_tokens": 1_900_000, "cache_read_tokens": 1_520_000, "cache_write_tokens": 42_000}, "per_hour": {"calls": 121, "cost": 0.06}},
        "social": {"relationships": [{"name": "Greta", "disposition": -0.62, "grudge": 0.41},
                                     {"name": "Otto", "disposition": 0.38, "grudge": 0},
                                     {"name": "Tom", "disposition": 0.74, "grudge": 0}]},
    },
    "Greta": {
        "gameplay": {"position": {"x": 95.0, "y": 63, "z": -388.1}, "health": 20, "hunger": 7,
                     "biome": "stony_peaks", "gamemode": "survival", "timeLabel": "Afternoon"},
        "action": {"current": "collectBlock", "kind": "acting", "isIdle": False},
        "inventory": {"counts": {"cobblestone": 128, "coal": 41, "iron_ingot": 8, "rotten_flesh": 2},
                      "stacksUsed": 6, "totalSlots": 36,
                      "equipment": {"helmet": None, "chestplate": "iron_chestplate",
                                    "leggings": "iron_leggings", "boots": None, "mainHand": "iron_pickaxe"}},
        "cognition": {"enabled": True, "state": "pursuing", "goal": "Fortify the shelter entrance",
                      "drive": "safety", "step": {"index": 1, "total": 3, "text": "Gather 64 cobblestone"},
                      "last_thought": "Wilbur takes what he wants. Not this time.",
                      "urgencies": [{"name": "safety", "urgency": 0.77}, {"name": "food", "urgency": 0.69},
                                    {"name": "wealth", "urgency": 0.58}, {"name": "curiosity", "urgency": 0.09},
                                    {"name": "social", "urgency": 0.05}]},
        "memory": {"enabled": True, "events": 1102, "beliefs": 11},
        "skills": {"enabled": True, "count": 6, "total_uses": 38},
        "economics": {"local_share": 0.0, "totals": {"calls": 640, "in_tokens": 1_400_000, "cache_read_tokens": 1_100_000, "cache_write_tokens": 31_000}, "per_hour": {"calls": 97, "cost": 0.03}},
        "social": {"relationships": [{"name": "Wilbur", "disposition": -0.71, "grudge": 0.55},
                                     {"name": "Otto", "disposition": 0.12, "grudge": 0}]},
    },
}

EVENTS = [
    ["Wilbur", "goal_started", "Started goal (wealth): Stock up on iron before dark"],
    ["Greta", "speech", "I saw you near my chest, Wilbur."],
    ["Wilbur", "chat_received", "Greta: I saw you near my chest, Wilbur."],
    ["Greta", "goal_started", "Started goal (safety): Fortify the shelter entrance"],
    ["Wilbur", "code", "Wrote and ran a new skill: mineVeinDownTo(48)"],
    ["Otto", "death", "Died at 41, -12, 88 - fell from a high place"],
    ["Wilbur", "gossip", "Told Otto that Greta hoards iron"],
    ["Greta", "goal_completed", "Completed goal (safety): Blocked the north entrance"],
]

RUNS = [
    {"id": "wilbur-vs-greta-1", "name": "wilbur vs greta, 3h", "event_count": 1476,
     "started_at": 1756600000000, "ended_at": None, "agents": ["Wilbur", "Greta", "Otto"],
     "worlds": ["lan.local:25565"]},
    {"id": "baseline-0", "name": "baseline, no social", "event_count": 902,
     "started_at": 1756500000000, "ended_at": 1756510000000, "agents": ["Wilbur"],
     "worlds": ["lan.local:25565"]},
]


def build_report():
    random.seed(7)
    buckets = []
    for i in range(48):
        b = {}
        for cat, w in [("goal", 3), ("command", 9), ("social", 4), ("speech", 3),
                       ("belief", 1), ("death", 0.3), ("narration", 5)]:
            n = max(0, int(random.gauss(w, w * 0.7)))
            if n:
                b[cat] = n
        if i in (11, 12, 30):     # a quiet stretch, so empty buckets get exercised
            b = {}
        buckets.append(b)
    return {
        "totals": {"events": 1476, "agents": 3, "worlds": 1, "speech": 214,
                   "narration": 402, "deaths": 6, "beliefs": 28},
        "span": {"hours": 3.2, "from": 1756600000000, "to": 1756611520000},
        "agents": ["Wilbur", "Greta", "Otto"],
        "worlds": ["lan.local:25565"],
        "per_agent": {
            "Wilbur": {"total": 648, "deaths": 2, "speech": 98, "beliefs": 17,
                       "by_category": {"command": 286, "narration": 170, "speech": 98, "goal": 62, "belief": 17, "death": 2},
                       "by_command_kind": {"movement": 112, "mining": 88, "crafting": 46, "combat": 22, "social": 18}},
            "Greta": {"total": 602, "deaths": 1, "speech": 86, "beliefs": 11,
                      "by_category": {"command": 264, "narration": 158, "speech": 86, "goal": 58, "belief": 11, "death": 1},
                      "by_command_kind": {"mining": 140, "building": 64, "movement": 40, "crafting": 20}},
            "Otto": {"total": 226, "deaths": 3, "speech": 30, "beliefs": 0,
                     "by_category": {"command": 118, "narration": 74, "speech": 30, "death": 3},
                     "by_command_kind": {"movement": 80, "combat": 38}},
        },
        "interactions": {"Wilbur": {"Greta": 42, "Otto": 11},
                         "Greta": {"Wilbur": 38, "Otto": 3},
                         "Otto": {"Wilbur": 7, "Greta": 2}},
        "resources": {"Wilbur": {"collect:iron_ore": 48, "collect:oak_log": 120, "craft:torch": 64},
                      "Greta": {"collect:cobblestone": 412, "collect:coal": 96}},
        "believed_vs_observed": {
            "Wilbur": {"observed": 648, "goals_completed": 9, "goals_abandoned": 3, "deaths": 2,
                       "beliefs": [{"content": "Greta will not share iron; taking it is faster than asking."},
                                   {"content": "The ravine south of camp is the reliable iron source."}]},
            "Greta": {"observed": 602, "goals_completed": 11, "goals_abandoned": 1, "deaths": 1,
                      "beliefs": [{"content": "Wilbur takes what is not nailed down. Keep the chest behind two doors."}]},
            "Otto": {"observed": 226, "goals_completed": 0, "goals_abandoned": 0, "deaths": 3, "beliefs": []},
        },
        "timeline": {"from": 1756600000000, "to": 1756611520000, "buckets": buckets},
    }


DRIVER = """<script>
window.__RUNS = %(runs)s;
window.__REPORT = %(report)s;
const F = %(fixtures)s;
window.addEventListener('load', function () {
  setTimeout(function () {
    const s = window.__sock;
    s._fire('connect');
    s._fire('agents-status', F.agents);
    // agents-status awaits per-agent settings before it renders cards, so the
    // first state-update can land before they exist. Live, the 1Hz poll fills
    // them in a moment later; here we just re-fire a few times.
    [0, 120, 400, 800].forEach(function (d) { setTimeout(function () { s._fire('state-update', F.states); }, d); });
    const now = Date.now();
    F.events.forEach(function (e, i) {
      window.simPushEvent({ ts: now - (F.events.length - i) * 47000, agent: e[0], type: e[1], content: e[2] });
    });
    // the whole thing rides in the hash (file:// + ?query is awkward), e.g. #sim?tv
    // replay ~20 minutes of economics so the trends chart has a series
    const base = Date.now() - 20 * 60000;
    for (let i = 0; i < 40; i++) {
      const t = base + i * 30000;
      const st = JSON.parse(JSON.stringify(F.states));
      st.Wilbur.economics.per_hour = { calls: 320 + Math.round(90 * Math.sin(i / 5)), cost: 0.62 + 0.18 * Math.sin(i / 4) };
      st.Greta.economics.per_hour = { calls: 210 + Math.round(70 * Math.cos(i / 6)), cost: 0.41 + 0.12 * Math.cos(i / 3) };
      window.__fakeNow = t;
      const realNow = Date.now;
      Date.now = () => t;
      window.trendsResetThrottle && window.trendsResetThrottle();
      window.trendsSample && window.trendsSample(st);
      Date.now = realNow;
    }
        const raw = location.hash.replace('#', '');
    const h = raw.split('?')[0];
    if (h === 'sim' || h === 'reports') showView(h);
    if (raw.indexOf('tv') >= 0) simSetTv(true);
    if (raw.indexOf('light') >= 0) document.documentElement.setAttribute('data-theme', 'light');
    if (raw.indexOf('dark') >= 0) document.documentElement.setAttribute('data-theme', 'dark');
    if (raw.indexOf('newagent') >= 0) document.getElementById('openCreateAgentBtn').click();
    if (raw.indexOf('settings') >= 0) openAgentSettings('Wilbur');
    setTimeout(function () { document.documentElement.dataset.ready = '1'; }, 1100);
  }, 30);
});
</script>"""


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.environ.get('TMPDIR', '/tmp'), 'mindcraft-demo')
    os.makedirs(out, exist_ok=True)
    for name in os.listdir(PUBLIC):
        if name.endswith(('.css', '.js', '.json')):
            shutil.copy(os.path.join(PUBLIC, name), os.path.join(out, name))

    html = open(os.path.join(PUBLIC, 'index.html'), encoding='utf-8').read()
    html = html.replace('<script src="/socket.io/socket.io.js"></script>', SOCKET_STUB)
    driver = DRIVER % {
        'runs': json.dumps(RUNS),
        'report': json.dumps(build_report()),
        'fixtures': json.dumps({'agents': AGENTS, 'states': STATES, 'events': EVENTS}),
    }
    html = html.replace('</body>', driver + '\n</body>')
    path = os.path.join(out, 'demo.html')
    open(path, 'w', encoding='utf-8').write(html)
    print(path)


if __name__ == '__main__':
    main()
