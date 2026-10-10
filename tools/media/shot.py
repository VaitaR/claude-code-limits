"""Screenshot the `.win` frame of each HTML page given, at 2x, to a PNG beside it.

Usage: uv run --with playwright python shot.py page.html [...]
Uses the installed Google Chrome (channel="chrome"), so no browser download.
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome")
    pg = b.new_page(device_scale_factor=2, viewport={"width": 1400, "height": 900})
    for src in sys.argv[1:]:
        pg.goto(pathlib.Path(src).resolve().as_uri())
        pg.locator(".win").screenshot(path=src.rsplit(".", 1)[0] + ".png", omit_background=True)
    b.close()
