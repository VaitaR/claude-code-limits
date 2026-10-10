"""ANSI capture (`tmux capture-pane -e -p`) -> HTML page in a terminal window frame.

Usage: python3 ans2html.py capture.ans out.html

A browser renders it with font fallback, which freeze's rasterizer lacks (it drew the band's
glyphs as boxes). Handles the SGR codes Claude Code emits: reset, bold, dim, 30-37/90-97,
38/48 with 256 colours or truecolour.
"""
import html, re, sys

def c256(n):
    base = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
            "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"]
    if n < 16:
        return base[n]
    if n < 232:
        n -= 16
        v = [0, 95, 135, 175, 215, 255]
        return "#%02x%02x%02x" % (v[n // 36], v[n // 6 % 6], v[n % 6])
    g = 8 + (n - 232) * 10
    return "#%02x%02x%02x" % (g, g, g)

def rgb(r, g, b):
    return "#%02x%02x%02x" % (int(r), int(g), int(b))

def convert(text):
    st = {"fg": None, "bg": None, "b": False, "dim": False}
    out = []
    for part in re.split(r"(\x1b\[[0-9;]*m)", text):
        m = re.fullmatch(r"\x1b\[([0-9;]*)m", part)
        if m:
            a = [int(x) if x else 0 for x in m.group(1).split(";")] or [0]
            i = 0
            while i < len(a):
                c = a[i]
                if c == 0: st = {"fg": None, "bg": None, "b": False, "dim": False}
                elif c == 1: st["b"] = True
                elif c == 2: st["dim"] = True
                elif c == 22: st["b"] = st["dim"] = False
                elif c == 39: st["fg"] = None
                elif c == 49: st["bg"] = None
                elif c in (38, 48) and a[i + 1] == 5:
                    st["fg" if c == 38 else "bg"] = c256(a[i + 2]); i += 2
                elif c in (38, 48) and a[i + 1] == 2:
                    st["fg" if c == 38 else "bg"] = rgb(*a[i + 2:i + 5]); i += 4
                elif 30 <= c <= 37: st["fg"] = c256(c - 30)
                elif 90 <= c <= 97: st["fg"] = c256(c - 82)
                i += 1
            continue
        if not part:
            continue
        css = []
        if st["fg"]: css.append("color:" + st["fg"])
        if st["bg"]: css.append("background:" + st["bg"])
        if st["b"]: css.append("font-weight:bold")
        if st["dim"]: css.append("opacity:.6")
        out.append('<span style="%s">%s</span>' % (";".join(css), html.escape(part)) if css else html.escape(part))
    return "".join(out)

src, dst = sys.argv[1], sys.argv[2]
body = convert(open(src, encoding="utf-8").read().rstrip("\n"))
open(dst, "w", encoding="utf-8").write("""<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:transparent}
.win{display:inline-block;margin:0;background:#1e1e1e;border-radius:10px;padding:18px 22px 20px;box-shadow:0 0 0 1px #333}
.dots{margin-bottom:14px}.dots i{display:inline-block;width:12px;height:12px;border-radius:50%;margin-right:8px}
pre{margin:0;color:#e5e5e5;font:14px/1.45 Menlo,'Apple Symbols',monospace;white-space:pre}
</style><div class="win"><div class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div><pre>""" + body + "</pre></div>")
