#!/usr/bin/env python3
"""
trace.py - behavioural trace for a long-running Mindcraft multi-agent world.

Built for runs measured in days. The Paper server log is the primary source:
every bot command and utterance lands there timestamped and exactly attributed.
Everything else is optional enrichment.

  ssh USER@MCHOST "docker exec mc cat /data/logs/latest.log" > mc.log
  ./trace.py --mc-log mc.log --bots-dir ~/mindcraft/bots --inspect
  ./trace.py --mc-log mc.log --bots-dir ~/mindcraft/bots --html report.html

Long runs: pass several logs at once, including Paper's gzipped archives.
Filenames like 2026-08-28-1.log.gz supply their own date.

  ./trace.py --mc-log 'logs/*.log.gz' logs/latest.log --html report.html

What it separates that a raw log does not:

  speech      the agent chose to say this
  narration   narrate_behavior auto-emission ("Fighting zombie!") - not thought
  command     a !command invocation, bucketed by activity type
  death       parsed from Paper's own death messages
  session     joined/left pairs, so downtime and crashes are visible

stdlib only.
"""

import argparse
import glob as globmod
import gzip
import html
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, date, timedelta

# ---------------------------------------------------------------------------
# Patterns. Run --inspect to see what falls through; tune here.
# ---------------------------------------------------------------------------

MC_LINE = re.compile(
    r"^\[(?P<t>\d{2}:\d{2}:\d{2})(?:\s+[A-Z]+)?\]"    # [00:00:02] or [22:47:03 INFO]
    r"(?:\s*\[[^\]]*\])*"                              # optional thread/level brackets
    r":\s*(?P<body>.*)$"
)
MC_PREFIX = re.compile(r"^(?:\[(?:Not Secure|Secure)\]\s*)+")
MC_CHAT = re.compile(r"^<(?P<agent>[A-Za-z0-9_]+)>\s*(?P<msg>.*)$")
MC_JOIN = re.compile(r"^(?P<agent>[A-Za-z0-9_]+) (?P<what>joined|left) the game\b")

MC_DEATH = re.compile(
    r"^(?P<agent>[A-Za-z0-9_]+) (?P<how>"
    r"was slain by|was shot by|was killed by|was blown up by|was pricked to death|"
    r"was fireballed by|was impaled by|was squashed by|was skewered by|"
    r"blew up|drowned|burned to death|went up in flames|starved to death|suffocated|"
    r"fell from a high place|hit the ground too hard|tried to swim in lava|"
    r"was struck by lightning|withered away|died|experienced kinetic energy"
    r")(?P<rest>.*)$"
)

# narrate_behavior auto-emissions. Mode output, not deliberation.
NARRATION = re.compile(
    r"^(Fighting\b|Killing\b|I'm dying\b|Picking up\b|Eating\b|Placing torch\b|"
    r"Placed torch\b|Digging\b|Escaping\b|Avoiding\b|Fleeing\b|Drowning\b|"
    r"Burning\b|Suffocating\b|Hunting\b|Sleeping\b|Waking\b|Item collected\b|"
    r"Defending\b|Torch placed\b|Trapped\b|Stuck\b)",
    re.I,
)

CMD = re.compile(r"!(?P<cmd>[A-Za-z][A-Za-z0-9_]{2,})(?:\((?P<args>[^)]*)\))?")
FNAME_DATE = re.compile(r"(?P<d>\d{4}-\d{2}-\d{2})")

SOCIAL_CMDS = {
    "startConversation", "endConversation", "goToPlayer", "followPlayer",
    "lookAtPlayer", "givePlayer", "attackPlayer", "stayWithPlayer",
}

ITEM_CMDS = {
    "collectBlocks", "putInChest", "takeFromChest", "craftRecipe",
    "smeltItem", "discard", "givePlayer", "consume", "equip",
}

CMD_KIND = {
    "collectBlocks": "gather", "searchForBlock": "gather", "mine": "gather",
    "goToRememberedPlace": "move", "goToCoordinates": "move",
    "goToPlayer": "move", "followPlayer": "move", "moveAway": "move",
    "searchForEntity": "move", "goToSurface": "move", "goToBed": "move",
    "craftRecipe": "craft", "smeltItem": "craft", "craftable": "craft",
    "placeHere": "build", "newAction": "build",
    "attack": "combat", "attackPlayer": "combat", "equip": "combat",
    "startConversation": "social", "endConversation": "social",
    "givePlayer": "social", "lookAtPlayer": "social",
    "viewChest": "inventory", "inventory": "inventory", "putInChest": "inventory",
    "takeFromChest": "inventory", "discard": "inventory", "consume": "inventory",
    "stats": "introspect", "stop": "introspect", "setMode": "introspect",
    "searchWiki": "introspect", "rememberHere": "introspect", "goal": "introspect",
}

# Palette: Minecraft materials against night slate.
KIND_COLOR = {
    "gather":     "#4a9d6e",   # emerald
    "craft":      "#c8963e",   # gold
    "build":      "#3a6ea5",   # lapis
    "move":       "#5c7183",   # stone
    "combat":     "#b8433a",   # redstone
    "social":     "#9b72c9",   # amethyst
    "inventory":  "#3f8b8b",   # diamond
    "introspect": "#6f8091",
    "speech":     "#d6c9a8",   # parchment
    "narration":  "#3d4a55",   # deliberately dim: this is noise
    "death":      "#e05a4f",
    "session":    "#8a97a3",
    "project":    "#7a9e5c",   # olive: long work, distinct from build actions
    "other":      "#4a5560",
}

AGENT_COLORS = ["#c87f4f", "#3a6ea5", "#4a9d6e", "#9b72c9", "#c8963e",
                "#3f8b8b", "#b8433a", "#8a97a3"]


def opener(path):
    return gzip.open(path, "rt", errors="replace") if path.endswith(".gz") \
        else open(path, "r", errors="replace")


def first_str_arg(args):
    m = re.search(r'["\']([^"\']+)["\']', args or "")
    return m.group(1) if m else None


def parse_qty(args):
    if not args:
        return None, None
    item = first_str_arg(args)
    n = re.search(r",\s*(\d+)", args)
    return item, (int(n.group(1)) if n else None)


def date_for(path, override):
    if override:
        return datetime.strptime(override, "%Y-%m-%d").date()
    m = FNAME_DATE.search(os.path.basename(path))
    if m:
        return datetime.strptime(m.group("d"), "%Y-%m-%d").date()
    return date.fromtimestamp(os.path.getmtime(path))


def parse_mc_log(path, log_date):
    events, unmatched = [], []
    prev, day = None, log_date
    with opener(path) as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            m = MC_LINE.match(line)
            if not m:
                if line.strip():
                    unmatched.append(line)
                continue
            t = datetime.strptime(m.group("t"), "%H:%M:%S").time()
            ts = datetime.combine(day, t)
            if prev and ts < prev - timedelta(hours=12):    # rolled past midnight
                day += timedelta(days=1)
                ts = datetime.combine(day, t)
            prev = ts
            body = MC_PREFIX.sub("", m.group("body")).strip()

            j = MC_JOIN.match(body)
            if j:
                events.append(dict(ts=ts, agent=j.group("agent"), kind="session",
                                   action=j.group("what"), text=body))
                continue

            d = MC_DEATH.match(body)
            if d:
                events.append(dict(ts=ts, agent=d.group("agent"), kind="death",
                                   action="death", cause=d.group("how"), text=body))
                continue

            c = MC_CHAT.match(body)
            if c:
                agent, msg = c.group("agent"), c.group("msg").strip()
                cmds = list(CMD.finditer(msg))
                if cmds:
                    for cm in cmds:
                        cmd, args = cm.group("cmd"), cm.group("args")
                        ev = dict(ts=ts, agent=agent,
                                  kind=CMD_KIND.get(cmd, "other"),
                                  action=cmd, text=msg)
                        if cmd in SOCIAL_CMDS:
                            ev["target"] = first_str_arg(args)
                            if cmd == "startConversation":
                                q = re.findall(r'["\']([^"\']+)["\']', args or "")
                                ev["said"] = q[-1] if len(q) > 1 else None
                        if cmd in ITEM_CMDS:
                            it, n = parse_qty(args)
                            ev["item"], ev["qty"] = it, n
                        events.append(ev)
                elif NARRATION.match(msg):
                    events.append(dict(ts=ts, agent=agent, kind="narration",
                                       action="narrate", text=msg))
                else:
                    events.append(dict(ts=ts, agent=agent, kind="speech",
                                       action="say", text=msg))
                continue

            unmatched.append(line)
    return events, unmatched


def parse_events_jsonl(path):
    """Read a native mindcraft event stream (runs/<id>/events.jsonl).

    This is the same file the in-app report reads, so the two analyzers agree
    on the same window by construction rather than by coincidence. It also
    carries what a Paper log physically cannot: goals, plans, beliefs, and
    social state.
    """
    # native event type -> this script's event kinds
    KIND = {
        "speech": "speech", "chat_received": "speech",
        "narration": "narration",
        "command": "command", "code": "command",
        "death": "death", "damage": "combat", "session": "session",
        "goal_started": "goal", "goal_completed": "goal",
        "goal_abandoned": "goal", "plan_revised": "goal",
        "project_started": "project", "project_completed": "project",
        "project_abandoned": "project", "milestone_started": "project",
        "milestone_completed": "project",
        "belief": "belief", "social": "social", "gossip": "social",
        "interruption": "interruption",
        "place": "discovery", "discovery": "discovery",
    }
    events, unmatched = [], []
    with opener(path) as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                unmatched.append(line[:200])
                continue
            if not isinstance(rec, dict) or "ts" not in rec or "agent" not in rec:
                unmatched.append(line[:200])
                continue
            data = rec.get("data") or {}
            cmd = data.get("command")
            kind = KIND.get(rec.get("type"), "other")
            if kind == "command" and cmd:
                kind = CMD_KIND.get(cmd.lstrip("!"), "other")
            ev = dict(
                ts=datetime.fromtimestamp(rec["ts"] / 1000.0),
                agent=rec["agent"],
                kind=kind,
                action=cmd or rec.get("type", "other"),
                text=rec.get("content", ""),
            )
            for src, dst in (("to", "target"), ("peer", "target"), ("teller", "target")):
                if data.get(src):
                    ev["target"] = data[src]
                    break
            if data.get("item"):
                ev["item"], ev["qty"] = data["item"], data.get("qty")
            if rec.get("world"):
                ev["world"] = rec["world"]
            events.append(ev)
    return events, unmatched


def load_memories(bots_dir):
    out = {}
    if not bots_dir or not os.path.isdir(bots_dir):
        return out
    for name in sorted(os.listdir(bots_dir)):
        p = os.path.join(bots_dir, name, "memory.json")
        if not os.path.isfile(p):
            continue
        rec = {"mtime": datetime.fromtimestamp(os.path.getmtime(p))}
        try:
            with open(p, errors="replace") as fh:
                d = json.load(fh)
        except Exception as e:
            rec["raw"] = f"could not parse memory.json: {e}"
            out[name] = rec
            continue
        for key in ("memory", "summary", "self_prompt", "last_sender"):
            if isinstance(d, dict) and d.get(key):
                rec[key] = d[key]
        if "memory" not in rec and isinstance(d, dict):
            rec["raw"] = json.dumps(d, indent=2)[:4000]
        out[name] = rec
    return out


# ---------------------------------------------------------------------------
# Derived views
# ---------------------------------------------------------------------------

def sessions_for(events, agent, t0, t1):
    marks = [e for e in events if e.get("agent") == agent and e["kind"] == "session"]
    out, open_at = [], None
    for e in marks:
        if e["action"] == "joined":
            if open_at is None:
                open_at = e["ts"]
        else:
            out.append(((open_at or t0), e["ts"], True))
            open_at = None
    if open_at is not None:
        out.append((open_at, t1, False))
    if not out:
        acts = [e["ts"] for e in events if e.get("agent") == agent]
        if acts:
            out.append((min(acts), max(acts), False))
    return out


def pressure_series(events, t0, span, buckets=180):
    """Hostile pressure over time, from combat + deaths + distress narration."""
    vals = [0.0] * buckets
    distress = re.compile(r"(?i)^(fighting|i'm dying|fleeing|escaping|burning|drowning)")
    for e in events:
        w = 3.0 if e["kind"] == "death" else \
            1.0 if e["kind"] == "combat" else \
            1.0 if (e["kind"] == "narration" and distress.match(e["text"])) else 0.0
        if not w:
            continue
        i = min(buckets - 1, int(buckets * ((e["ts"] - t0).total_seconds() / span)))
        vals[i] += w
    peak = max(vals) or 1.0
    return [v / peak for v in vals]


def build_edges(events):
    edges = Counter()
    for e in events:
        tgt = e.get("target")
        if tgt and e.get("agent") and tgt != e["agent"]:
            edges[(e["agent"], tgt)] += 1
    return edges


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

CSS = """
*{box-sizing:border-box}
body{background:#0f1419;color:#c9d4de;margin:0;padding:38px 30px 80px;
 font:13px/1.6 ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace}
h1{font-size:15px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;
 margin:0 0 6px;color:#e6eef5}
h2{font-size:11px;font-weight:600;letter-spacing:.26em;text-transform:uppercase;
 color:#6f8091;margin:44px 0 12px;padding-bottom:7px;border-bottom:1px solid #1e2831}
.sub{color:#6f8091;font-size:12px;margin:0 0 26px}
.big{font-size:30px;font-weight:600;letter-spacing:-.02em;color:#e6eef5;line-height:1.15}
.lbl{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#5c6c7a}
.grid{display:grid;gap:12px}
.stats{grid-template-columns:repeat(auto-fit,minmax(158px,1fr));margin-bottom:6px}
.cards{grid-template-columns:repeat(auto-fit,minmax(272px,1fr))}
.card{background:#141b22;border:1px solid #1e2831;border-radius:3px;padding:15px 16px}
.card.agent{border-left:3px solid var(--c)}
.nm{font-size:15px;font-weight:600;letter-spacing:.04em;color:var(--c)}
.kv{display:flex;justify-content:space-between;gap:10px;padding:3px 0;
 border-bottom:1px dotted #1c242c;font-size:12px}
.kv:last-child{border-bottom:0}.kv span:last-child{color:#e6eef5}
.bars{margin-top:9px;line-height:1}
.bar{height:5px;border-radius:2px;display:inline-block;margin-right:2px}
table{border-collapse:collapse;width:100%;font-size:12px}
th{background:#141b22;color:#6f8091;font-weight:600;font-size:10px;
 letter-spacing:.14em;text-transform:uppercase;text-align:left;padding:7px 9px;
 position:sticky;top:0;border-bottom:1px solid #1e2831}
td{padding:5px 9px;border-bottom:1px solid #171f26;vertical-align:top}
tr:hover td{background:#141b22}
.num{text-align:right;font-variant-numeric:tabular-nums}
.dim{color:#4a5560}.warn{color:#c8963e}
.ledger{background:#141b22;border:1px solid #1e2831;border-left:3px solid #9b72c9;
 border-radius:3px;padding:11px 14px;margin-bottom:9px}
.ledger .when{font-size:10px;letter-spacing:.16em;color:#5c6c7a;text-transform:uppercase}
.ledger .who{font-weight:600}.ledger .said{color:#d6c9a8;margin-top:5px}
.mem{background:#141b22;border:1px solid #1e2831;border-radius:3px;padding:15px 16px;
 white-space:pre-wrap;font-size:12px;line-height:1.65;color:#b3c1cd;
 max-height:340px;overflow:auto}
#log{max-height:600px;overflow:auto;border:1px solid #1e2831;border-radius:3px}
input,select{background:#141b22;color:#c9d4de;border:1px solid #26313b;
 border-radius:3px;padding:6px 9px;font:inherit;font-size:12px}
input:focus,select:focus{outline:2px solid #3a6ea5;outline-offset:1px}
.chips{margin:0 0 10px}
.chip{display:inline-block;font-size:10px;letter-spacing:.1em;text-transform:uppercase;
 color:#5c6c7a;margin-right:14px}
.chip i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;
 vertical-align:-1px}
.note{color:#6f8091;font-size:12px;margin:0 0 14px;max-width:74ch}
code{background:#1a232b;padding:1px 5px;border-radius:2px;color:#9fb0be}
@media(max-width:640px){body{padding:22px 14px 60px}.big{font-size:24px}}
"""


def svg_timeline(events, agents, acolor, t0, t1, span):
    W, LANE, PADL, PADT = 1180, 40, 118, 78
    inner = W - PADL - 26
    H = PADT + LANE * len(agents) + 26

    def x_of(ts):
        return PADL + inner * ((ts - t0).total_seconds() / span)

    parts = []

    # signature element: hostile-pressure ribbon
    press = pressure_series(events, t0, span)
    n = len(press)
    ridge = [f"{PADL + inner*(i/(n-1)):.1f},{PADT-10-v*48:.1f}"
             for i, v in enumerate(press)]
    parts.append(f'<polygon points="{PADL},{PADT-10} {" ".join(ridge)} '
                 f'{PADL+inner},{PADT-10}" fill="#b8433a" opacity="0.15"/>')
    parts.append(f'<polyline points="{" ".join(ridge)}" fill="none" '
                 f'stroke="#b8433a" stroke-width="1" opacity="0.55"/>')
    parts.append(f'<text x="14" y="{PADT-50}" fill="#5c6c7a" font-size="9" '
                 f'letter-spacing="2">HOSTILE</text>')
    parts.append(f'<text x="14" y="{PADT-38}" fill="#5c6c7a" font-size="9" '
                 f'letter-spacing="2">PRESSURE</text>')

    step = max(1, int(round(span / 3600 / 14)))
    hr = t0.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    while hr < t1:
        gx = x_of(hr)
        parts.append(f'<line x1="{gx:.1f}" y1="{PADT-10}" x2="{gx:.1f}" y2="{H-22}" '
                     f'stroke="#1a232b" stroke-width="1"/>')
        parts.append(f'<text x="{gx:.1f}" y="{H-8}" fill="#3f4c58" font-size="9" '
                     f'text-anchor="middle">{hr:%H:%M}</text>')
        hr += timedelta(hours=step)

    for i, a in enumerate(agents):
        mid = PADT + i * LANE + LANE / 2
        for (s, e, _c) in sessions_for(events, a, t0, t1):
            xs, xe = x_of(s), x_of(max(e, s))
            parts.append(f'<rect x="{xs:.1f}" y="{mid-11:.0f}" '
                         f'width="{max(xe-xs,1.5):.1f}" height="22" '
                         f'fill="{acolor[a]}" opacity="0.09" rx="2"/>')
        parts.append(f'<line x1="{PADL}" y1="{mid}" x2="{W-26}" y2="{mid}" '
                     f'stroke="#1a232b" stroke-width="1"/>')
        parts.append(f'<text x="14" y="{mid+4}" fill="{acolor[a]}" font-size="12" '
                     f'font-weight="600">{html.escape(a)}</text>')

    for e in events:
        a = e.get("agent")
        if a not in agents or e["kind"] == "session":
            continue
        mid = PADT + agents.index(a) * LANE + LANE / 2
        x = x_of(e["ts"])
        k = e["kind"]
        tip = (f'{e["ts"]:%d %b %H:%M:%S}  {a}  {e["action"]}\n'
               f'{(e.get("text") or "")[:200]}')
        if k == "death":
            parts.append(f'<circle cx="{x:.1f}" cy="{mid}" r="4.2" fill="none" '
                         f'stroke="{KIND_COLOR["death"]}" stroke-width="1.4">'
                         f'<title>{html.escape(tip)}</title></circle>')
            continue
        h, op = (16, .95) if k in ("speech", "social") else (11, .62)
        if k == "narration":
            h, op = 6, .32
        parts.append(f'<rect x="{x:.1f}" y="{mid-h/2:.1f}" width="2.4" height="{h}" '
                     f'fill="{KIND_COLOR.get(k, KIND_COLOR["other"])}" opacity="{op}">'
                     f'<title>{html.escape(tip)}</title></rect>')

    return (f'<svg width="100%" viewBox="0 0 {W} {H}" role="img" '
            f'aria-label="agent activity timeline">{"".join(parts)}</svg>')


def render_html(events, memories, out_path, sources):
    events = [e for e in events if e.get("agent")]
    if not events:
        print("no attributed events", file=sys.stderr)
        return
    agents = sorted({e["agent"] for e in events},
                    key=lambda a: -sum(1 for e in events if e["agent"] == a))
    acolor = {a: AGENT_COLORS[i % len(AGENT_COLORS)] for i, a in enumerate(agents)}
    t0 = min(e["ts"] for e in events)
    t1 = max(e["ts"] for e in events)
    span = max((t1 - t0).total_seconds(), 1)
    hours = span / 3600

    per = defaultdict(Counter)
    for e in events:
        per[e["agent"]][e["kind"]] += 1
    deaths = Counter(e["agent"] for e in events if e["kind"] == "death")
    social = [e for e in events if e["kind"] == "social" or e.get("target")]
    speech = [e for e in events if e["kind"] == "speech"]
    narr = sum(1 for e in events if e["kind"] == "narration")
    edges = build_edges(events)

    top = f"""
<div class="grid stats">
  <div class="card"><div class="lbl">Observed</div><div class="big">{hours:.1f}h</div>
    <div class="dim">{t0:%d %b %H:%M} &rarr; {t1:%d %b %H:%M}</div></div>
  <div class="card"><div class="lbl">Social acts</div><div class="big">{len(social)}</div>
    <div class="dim">{len(social)/hours:.1f} per hour</div></div>
  <div class="card"><div class="lbl">Deliberate speech</div><div class="big">{len(speech)}</div>
    <div class="dim">{narr} auto-narrations excluded</div></div>
  <div class="card"><div class="lbl">Deaths</div><div class="big">{sum(deaths.values())}</div>
    <div class="dim">{html.escape(', '.join(f'{a} {n}' for a, n in deaths.most_common(3)) or 'none recorded')}</div></div>
</div>"""

    cards = []
    for a in agents:
        tot = sum(per[a].values())
        sess = sessions_for(events, a, t0, t1)
        up = sum((e - s).total_seconds() for s, e, _ in sess)
        acts = Counter(e["action"] for e in events if e["agent"] == a
                       and e["kind"] not in ("narration", "session", "speech"))
        bars = "".join(
            f'<span class="bar" style="width:{max(3, 150*per[a][k]/max(tot,1)):.0f}px;'
            f'background:{KIND_COLOR.get(k, "#4a5560")}" title="{k}: {per[a][k]}"></span>'
            for k in sorted(per[a], key=lambda x: -per[a][x]) if k != "session")
        rows = "".join(f'<div class="kv"><span>{html.escape(c)}</span><span>{n}</span></div>'
                       for c, n in acts.most_common(5))
        out_deg = sum(v for (s, _), v in edges.items() if s == a)
        cards.append(f"""
<div class="card agent" style="--c:{acolor[a]}">
  <div class="nm">{html.escape(a)}</div>
  <div class="bars">{bars}</div>
  <div style="margin-top:11px">
    <div class="kv"><span class="dim">events</span><span>{tot}</span></div>
    <div class="kv"><span class="dim">connected</span><span>{up/3600:.1f}h of {hours:.1f}h &middot; {len(sess)} session(s)</span></div>
    <div class="kv"><span class="dim">deaths</span><span>{deaths[a]}</span></div>
    <div class="kv"><span class="dim">spoke</span><span>{per[a]['speech']}</span></div>
    <div class="kv"><span class="dim">reached out</span><span>{out_deg}</span></div>
  </div>
  <div style="margin-top:11px"><div class="lbl">Most frequent</div>{rows}</div>
</div>""")

    ledger = []
    for e in sorted(social, key=lambda x: x["ts"])[:150]:
        said = e.get("said")
        tgt = ""
        if e.get("target"):
            tgt = (f'<span class="dim">&rarr;</span> <span class="who" '
                   f'style="color:{acolor.get(e["target"], "#8a97a3")}">'
                   f'{html.escape(e["target"])}</span>')
        ledger.append(f"""
<div class="ledger">
  <div class="when">{e['ts']:%d %b %H:%M:%S}</div>
  <div><span class="who" style="color:{acolor.get(e['agent'], '#ccc')}">{html.escape(e['agent'])}</span>
   <span class="dim">{html.escape(e['action'])}</span> {tgt}</div>
  {'<div class="said">&ldquo;%s&rdquo;</div>' % html.escape(said) if said else ''}
</div>""")
    if not ledger:
        ledger = ['<p class="note warn">No agent addressed another agent in this '
                  'window. Either no goals are set, or they never came within '
                  'range of each other. Fix this first if you want social behaviour.</p>']

    mrows = "".join(
        f'<tr><td style="color:{acolor[a]}">{html.escape(a)}</td>'
        + "".join((f'<td class="num">{edges[(a,b)]}</td>' if edges[(a, b)]
                   else '<td class="num dim">·</td>') if a != b
                  else '<td class="num dim">&mdash;</td>' for b in agents)
        + f'<td class="num">{sum(v for (s,_),v in edges.items() if s == a)}</td></tr>'
        for a in agents)

    flow = defaultdict(Counter)
    for e in events:
        if e.get("item"):
            flow[e["agent"]][(e["action"], e["item"])] += (e.get("qty") or 1)
    frows = "".join(
        f'<tr><td style="color:{acolor[a]}">{html.escape(a)}</td>'
        f'<td>{html.escape(act)}</td><td>{html.escape(item)}</td>'
        f'<td class="num">{n}</td></tr>'
        for a in agents for (act, item), n in flow[a].most_common(8))

    mems = []
    for a in agents:
        rec = memories.get(a)
        if not rec:
            continue
        txt = rec.get("memory") or rec.get("summary") or rec.get("raw") or "(empty)"
        mems.append(f'<h2 style="color:{acolor[a]}">{html.escape(a)} &mdash; self-summary '
                    f'<span class="dim">as of {rec["mtime"]:%d %b %H:%M}</span></h2>'
                    f'<div class="mem">{html.escape(str(txt))}</div>')
    if not mems:
        mems = ['<p class="note">No memory files loaded. Pass <code>--bots-dir '
                '~/mindcraft/bots</code> to include each agent\'s own account of '
                'the run alongside what it actually did.</p>']

    kinds_present = [k for k in KIND_COLOR if any(per[a][k] for a in agents)]
    chips = "".join(f'<span class="chip"><i style="background:{KIND_COLOR[k]}"></i>{k}</span>'
                    for k in kinds_present)

    logrows = "".join(
        f"<tr data-a='{html.escape(e['agent'])}' data-k='{e['kind']}'>"
        f"<td class='dim'>{e['ts']:%d %b %H:%M:%S}</td>"
        f"<td style='color:{acolor[e['agent']]}'>{html.escape(e['agent'])}</td>"
        f"<td class='dim'>{e['kind']}</td><td>{html.escape(e['action'])}</td>"
        f"<td>{html.escape(e.get('target') or '')}</td>"
        f"<td>{html.escape((e.get('text') or '')[:240])}</td></tr>"
        for e in sorted(events, key=lambda x: x["ts"]))

    doc = f"""<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mindcraft behavioural trace</title><style>{CSS}</style>
<h1>Mindcraft behavioural trace</h1>
<p class="sub">{len(events)} attributed events &middot; {len(agents)} agents &middot;
 {html.escape(', '.join(os.path.basename(s) for s in sources))}</p>
{top}

<h2>Timeline</h2>
<p class="note">Tall marks are speech and social acts. Short dim marks are
 <code>narrate_behavior</code> auto-emissions, not deliberation. Rings are deaths.
 The tinted band behind each lane is that agent's session; a gap means it was
 disconnected. The ridge above is hostile pressure, from combat and death
 density. Hover any mark for detail.</p>
<div class="chips">{chips}</div>
{svg_timeline(events, agents, acolor, t0, t1, span)}

<h2>Agents</h2>
<div class="grid cards">{''.join(cards)}</div>

<h2>Interactions</h2>
<p class="note">Every moment one agent addressed another, in full. This is the
 scarcest signal in the run and the reason to read it first.</p>
{''.join(ledger)}

<h2>Who addressed whom</h2>
<table><tr><th></th>{''.join(f'<th>{html.escape(a)}</th>' for a in agents)}
<th class="num">out</th></tr>{mrows}</table>

<h2>Resource flow</h2>
{'<table><tr><th>agent</th><th>action</th><th>item</th><th class="num">qty</th></tr>'
 + frows + '</table>' if frows else '<p class="note">No item-bearing commands parsed.</p>'}

<h2>What each agent believes happened</h2>
{''.join(mems)}

<h2>Event log</h2>
<p><input id="q" placeholder="filter text…" size="34">
<select id="ka"><option value="">all agents</option>
{''.join(f'<option>{html.escape(a)}</option>' for a in agents)}</select>
<select id="kk"><option value="">all kinds</option>
{''.join(f'<option>{k}</option>' for k in kinds_present)}</select>
<label style="margin-left:10px"><input type="checkbox" id="hn" checked>
 hide narration</label></p>
<div id="log"><table id="t"><tr><th>time</th><th>agent</th><th>kind</th>
<th>action</th><th>target</th><th>text</th></tr>{logrows}</table></div>
<script>
const q=document.getElementById('q'),ka=document.getElementById('ka'),
 kk=document.getElementById('kk'),hn=document.getElementById('hn'),
 rows=[...document.querySelectorAll('#t tr')].slice(1);
function f(){{const s=q.value.toLowerCase(),a=ka.value,k=kk.value,h=hn.checked;
 rows.forEach(r=>{{const ok=(!a||r.dataset.a===a)&&(!k||r.dataset.k===k)&&
  !(h&&r.dataset.k==='narration')&&
  (!s||r.textContent.toLowerCase().includes(s));r.style.display=ok?'':'none';}});}}
[q,ka,kk,hn].forEach(el=>el.addEventListener('input',f));f();
</script></html>"""
    with open(out_path, "w") as fh:
        fh.write(doc)
    print(f"wrote {out_path}  ({len(events)} events, {len(agents)} agents, {hours:.1f}h)")


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--mc-log", nargs="+",
                   help="Paper server log(s); .gz and glob patterns accepted")
    p.add_argument("--events", nargs="+",
                   help="native mindcraft event stream(s): runs/<id>/events.jsonl. "
                        "Richer than the server log (goals, beliefs, social) and the "
                        "same source the in-app report uses.")
    p.add_argument("--bots-dir", help="mindcraft/bots directory, for memory.json")
    p.add_argument("--date", help="date override for logs with no date in the filename")
    p.add_argument("--since", help="drop events before HH:MM or YYYY-MM-DDTHH:MM")
    p.add_argument("--inspect", action="store_true", help="parse stats; run this first")
    p.add_argument("--timeline", action="store_true")
    p.add_argument("--jsonl")
    p.add_argument("--html")
    a = p.parse_args()

    if not a.mc_log and not a.events:
        sys.exit("give --mc-log (Paper server logs) or --events (runs/<id>/events.jsonl)")

    if a.events:
        paths = []
        for pat in a.events:
            hits = sorted(globmod.glob(pat)) or ([pat] if os.path.exists(pat) else [])
            if not hits:
                print(f"warning: no file matched {pat}", file=sys.stderr)
            paths += hits
        if not paths:
            sys.exit("no input files")
        events, unmatched = [], []
        for pth in paths:
            ev, un = parse_events_jsonl(pth)
            events += ev
            unmatched += un
        events.sort(key=lambda e: e["ts"])
        if not events:
            sys.exit("parsed 0 events")
        _finish(a, events, unmatched, paths)
        return

    paths = []
    for pat in a.mc_log:
        hits = sorted(globmod.glob(pat)) or ([pat] if os.path.exists(pat) else [])
        if not hits:
            print(f"warning: no file matched {pat}", file=sys.stderr)
        paths += hits
    if not paths:
        sys.exit("no input files")

    events, unmatched = [], []
    for pth in paths:
        ev, un = parse_mc_log(pth, date_for(pth, a.date))
        events += ev
        unmatched += un
    events.sort(key=lambda e: e["ts"])
    if not events:
        sys.exit("parsed 0 events - run --inspect to see unmatched lines")

    if a.since:
        s = a.since
        cut = (datetime.fromisoformat(s) if ("T" in s or "-" in s)
               else datetime.combine(events[0]["ts"].date(),
                                     datetime.strptime(s, "%H:%M").time()))
        events = [e for e in events if e["ts"] >= cut]

    memories = load_memories(a.bots_dir)
    _finish(a, events, unmatched, paths)


def _finish(a, events, unmatched, paths):
    """Shared output stage for both input sources (--mc-log and --events)."""
    memories = load_memories(a.bots_dir)

    if a.inspect:
        print(f"files {len(paths)}   events {len(events)}   unmatched {len(unmatched)}")
        print(f"span  {events[0]['ts']:%d %b %H:%M} -> {events[-1]['ts']:%d %b %H:%M}")
        for title, ctr in (("by agent", Counter(e["agent"] for e in events)),
                           ("by kind", Counter(e["kind"] for e in events))):
            print(f"\n{title}:")
            for k, v in ctr.most_common():
                print(f"  {k:<16} {v}")
        print("\nby action:")
        for k, v in Counter(e["action"] for e in events).most_common(24):
            print(f"  {k:<22} {v}")
        print(f"\nmemory files: {', '.join(memories) or 'none'}")
        if unmatched:
            print("\nunmatched samples:")
            for line in unmatched[:12]:
                print(f"  | {line[:150]}")
        return

    if a.timeline:
        for e in events:
            tgt = f" -> {e['target']}" if e.get("target") else ""
            print(f"{e['ts']:%m-%d %H:%M:%S} {e['agent']:<12} {e['kind']:<10} "
                  f"{e['action']:<18}{tgt}  {(e.get('text') or '')[:90]}")

    if a.jsonl:
        with open(a.jsonl, "w") as fh:
            for e in events:
                o = dict(e)
                o["ts"] = e["ts"].isoformat()
                fh.write(json.dumps(o) + "\n")
        print(f"wrote {a.jsonl}")

    if a.html:
        render_html(events, memories, a.html, paths)


if __name__ == "__main__":
    main()
