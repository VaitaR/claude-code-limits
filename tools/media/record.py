"""Record the README demo: drive Claude Code in tmux and save ANSI frames with hold times.

Usage:
  tmux new-session -d -s gif -x 100 -y 24 -c <this repo> \
      "CLAUDE_CODE_PLUGIN_DIRS=<this repo> claude"
  python3 record.py frames/          # one turn with an Explore subagent, then a hover per segment

Writes frames/fNNN.ans and frames/frames.json ([file, hold_ms] pairs). Each frame is cropped at the
rule under the prompt box, which drops the status line, and padded at the top to one height. A
waiting frame holds at most MAX_HOLD. Render with ans2html.py and shot.py, then gif.py.
"""
import json, pathlib, re, subprocess, sys, time

OUT = pathlib.Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
PROMPT = "Use an Explore subagent to find where the band above the prompt is drawn"
MAX_HOLD = 2600
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
frames = []

def tm(*a):
    return subprocess.run(["tmux", *a], capture_output=True, text=True).stdout

def grab():
    lines = tm("capture-pane", "-t", "gif", "-e", "-p").split("\n")
    plain = [ANSI.sub("", l) for l in lines]
    rules = [i for i, l in enumerate(plain) if l.startswith("────")]
    end = rules[-1] if len(rules) >= 2 else len(lines) - 1
    return "\n".join(lines[: end + 1]), plain

def snap(hold):
    ans, plain = grab()
    if frames and frames[-1][2] == ans:
        frames[-1][1] = min(frames[-1][1] + hold, max(MAX_HOLD, hold))
    else:
        frames.append([f"f{len(frames):03d}.ans", hold, ans])
    return plain

def band(plain):
    return next(((i, l) for i, l in enumerate(plain) if l.startswith("5h ━")), (None, ""))

def hover(text, hold):
    row, line = band(grab()[1])
    col = line.find(text)
    if row is None or col < 0:
        sys.exit(f"no band segment {text!r} on screen")
    tm("send-keys", "-t", "gif", "-l", f"\x1b[<35;{col + 3};{row + 1}M")  # SGR move, 1-based
    time.sleep(0.6)
    snap(hold)
    tm("send-keys", "-t", "gif", "-l", "\x1b[<35;50;2M")  # move off: the hover covers the band
    time.sleep(0.4)

snap(1500)
words = PROMPT.split(" ")
for i in range(0, len(words), 2):
    tm("send-keys", "-t", "gif", "-l", " ".join(words[i:i + 2]) + (" " if i + 2 < len(words) else ""))
    time.sleep(0.15)
    snap(120)
snap(500)
tm("send-keys", "-t", "gif", "C-m")

t0, agent_seen, hovered, idle = time.time(), None, False, 0
while time.time() - t0 < 150:
    time.sleep(1.0)
    plain = snap(450)
    if "◐" in band(plain)[1]:
        agent_seen = agent_seen or time.time()
    if agent_seen and not hovered and time.time() - agent_seen > 4:
        hover("◐", 2200)
        hovered = True
    busy = any("esc to interrupt" in l or "Waiting for" in l for l in plain)
    idle = 0 if busy else idle + 1
    if hovered and idle >= 3:
        break

for seg, hold in (("5h", 2000), ("7d", 1800), ("ctx", 2000), ("cache", 2200), ("$", 2400)):
    hover(seg, hold)
snap(1500)

rows = max(f[2].count("\n") + 1 for f in frames)
for name, _, ans in frames:
    (OUT / name).write_text("\n" * (rows - ans.count("\n") - 1) + ans)
(OUT / "frames.json").write_text(json.dumps([[n, h] for n, h, _ in frames]))
print(len(frames), "frames,", sum(h for _, h, _ in frames) / 1000, "s")
