"""A small kit for the README's diagrams.

Each diagram is drawn with semantic classes (``blue`` for central bank money,
``green`` for deposits and banks, ``amber`` for securities, ``violet`` for
ISO 20022 messages, ``red`` for a failure, ``slate`` for the rest) and written
as ``<name>.svg`` on an opaque light background, so it reads the same on a
light or a dark page. Text stays text; fonts are the system's.
"""

from __future__ import annotations

import os
from xml.sax.saxutils import escape

SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"

FAMILIES = ("blue", "green", "amber", "violet", "red", "slate")

# fill (soft), stroke, ink (text on soft), solid (badges, text on it is white)
PALETTES = {
    "light": {
        "bg": "#ffffff",
        "text": "#1f2328",
        "muted": "#59636e",
        "faint": "#818b98",
        "panel": "#f6f8fa",
        "border": "#d1d9e0",
        "rule": "#d1d9e0",
        "on-solid": "#ffffff",
        "blue": ("#ddf4ff", "#0969da", "#0a3069", "#0969da"),
        "green": ("#dafbe1", "#1a7f37", "#116329", "#1a7f37"),
        "amber": ("#fff8c5", "#9a6700", "#6c3b00", "#9a6700"),
        "violet": ("#fbefff", "#8250df", "#512a97", "#8250df"),
        "red": ("#ffebe9", "#cf222e", "#82071e", "#cf222e"),
        "slate": ("#f6f8fa", "#818b98", "#1f2328", "#59636e"),
    },
}


def stylesheet(theme: str) -> str:
    p = PALETTES[theme]
    css = [
        f".bg{{fill:{p['bg']}}}",
        f".frame{{stroke:{p['border']};stroke-width:1}}",
        f"text{{font-family:{SANS};fill:{p['text']}}}",
        f".mono{{font-family:{MONO}}}",
        f".muted{{fill:{p['muted']}}}",
        f".faint{{fill:{p['faint']}}}",
        f".panel{{fill:{p['panel']};stroke:{p['border']};stroke-width:1}}",
        f".card{{fill:{p['bg']};stroke:{p['border']};stroke-width:1}}",
        f".rule{{stroke:{p['rule']};stroke-width:1;fill:none}}",
        f".rule-dash{{stroke:{p['rule']};stroke-width:1.5;fill:none;stroke-dasharray:4 4}}",
        f".on-solid{{fill:{p['on-solid']}}}",
        f".text-fill{{fill:{p['text']}}}",
        f".muted-line{{stroke:{p['muted']};stroke-width:1.5;fill:none}}",
        f".muted-mark{{fill:{p['muted']}}}",
    ]
    for f in FAMILIES:
        soft, stroke, ink, solid = p[f]
        css += [
            f".{f}-box{{fill:{soft};stroke:{stroke};stroke-width:1.5}}",
            f".{f}-soft{{fill:{soft}}}",
            f".{f}-ink{{fill:{ink}}}",
            f".{f}-solid{{fill:{solid}}}",
            f".{f}-line{{stroke:{stroke};stroke-width:1.75;fill:none}}",
            f".{f}-dash{{stroke:{stroke};stroke-width:1.5;fill:none;stroke-dasharray:5 4}}",
            f".{f}-stroke{{fill:{stroke}}}",
            f".{f}-edge{{fill:none;stroke:{stroke};stroke-width:1.5}}",
        ]
    return "\n".join(css)


# Approximate advance widths, in em, for the system sans at regular weight.
_NARROW = set("iljtfI.,:;'!|()[] ")
_WIDE = set("mwMW@%")


def text_width(s: str, size: float, mono: bool = False, bold: bool = False) -> float:
    if mono:
        return len(s) * size * 0.61
    w = 0.0
    for ch in s:
        if ch in _NARROW:
            w += 0.30
        elif ch in _WIDE:
            w += 0.86
        elif ch.isupper() or ch.isdigit():
            w += 0.64 if ch.isupper() else 0.57
        elif ch in "→←↔·–—":
            w += 0.9 if ch in "→←↔—" else 0.5
        else:
            w += 0.53
    return w * size * (1.06 if bold else 1.0)


class Doc:
    def __init__(self, name: str, width: int, height: int, title: str, desc: str):
        self.name, self.width, self.height = name, width, height
        self.title, self.desc = title, desc
        self.items: list[str] = []
        self.warnings: list[str] = []

    # ---- primitives -------------------------------------------------------
    def raw(self, s: str) -> None:
        self.items.append(s)

    def rect(self, x, y, w, h, cls, rx=8):
        self.raw(f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{rx:g}" class="{cls}"/>')

    def line(self, x1, y1, x2, y2, cls):
        self.raw(f'<line x1="{x1:g}" y1="{y1:g}" x2="{x2:g}" y2="{y2:g}" class="{cls}"/>')

    def circle(self, cx, cy, r, cls):
        self.raw(f'<circle cx="{cx:g}" cy="{cy:g}" r="{r:g}" class="{cls}"/>')

    def text(self, x, y, s, size=14, cls="", anchor="start", weight=None, mono=False, maxw=None):
        attrs = [f'x="{x:g}"', f'y="{y:g}"', f'font-size="{size:g}"']
        classes = ([cls] if cls else []) + (["mono"] if mono else [])
        if classes:
            attrs.append(f'class="{" ".join(classes)}"')
        if anchor != "start":
            attrs.append(f'text-anchor="{anchor}"')
        if weight:
            attrs.append(f'font-weight="{weight}"')
        if maxw is not None:
            w = text_width(s, size, mono, bool(weight and int(weight) >= 600))
            if w > maxw:
                self.warnings.append(f"text too wide ({w:.0f} > {maxw:.0f}): {s!r}")
        self.raw(f"<text {' '.join(attrs)}>{escape(s)}</text>")

    def rich(self, x, y, parts, size=14, anchor="start", cls=""):
        """One line of text in runs: each part is (string, cls, weight, mono)."""
        spans = []
        for part in parts:
            s, pcls, weight, mono = (list(part) + [None, None, False])[:4]
            a = []
            c = ([pcls] if pcls else []) + (["mono"] if mono else [])
            if c:
                a.append(f'class="{" ".join(c)}"')
            if weight:
                a.append(f'font-weight="{weight}"')
            spans.append(f"<tspan {' '.join(a)}>{escape(s)}</tspan>" if a else escape(s))
        attrs = [f'x="{x:g}"', f'y="{y:g}"', f'font-size="{size:g}"']
        if anchor != "start":
            attrs.append(f'text-anchor="{anchor}"')
        if cls:
            attrs.append(f'class="{cls}"')
        self.raw(f"<text {' '.join(attrs)}>{''.join(spans)}</text>")

    def lines(self, x, y, rows, size=14, lh=None, cls="", anchor="start", weight=None, mono=False, maxw=None):
        lh = lh or round(size * 1.4)
        for i, r in enumerate(rows):
            self.text(x, y + i * lh, r, size, cls, anchor, weight, mono, maxw)
        return y + len(rows) * lh

    # ---- composites -------------------------------------------------------
    def badge(self, cx, cy, n, fam="slate", r=11):
        self.circle(cx, cy, r, f"{fam}-solid")
        self.text(cx, cy + 4.5, str(n), 13, "on-solid", "middle", "700")

    def chip(self, x, y, s, fam="slate", size=13, mono=True, h=24, pad=9, anchor="start", weight=None):
        w = text_width(s, size, mono, bool(weight)) + 2 * pad
        if anchor == "middle":
            x -= w / 2
        elif anchor == "end":
            x -= w
        self.rect(x, y, w, h, f"{fam}-box", 6)
        self.text(x + w / 2, y + h / 2 + size * 0.36, s, size, f"{fam}-ink", "middle", weight, mono)
        return w

    def box(self, x, y, w, h, fam, title=None, sub=None, rows=(), size=14, title_size=15, rx=10, align="middle",
            mono_rows=False, pad=14, cls=None, row_cls=None):
        self.rect(x, y, w, h, cls or f"{fam}-box", rx)
        cx = x + w / 2 if align == "middle" else x + pad
        ty = y + pad + title_size * 0.8
        maxw = w - 2 * pad
        if title:
            self.text(cx, ty, title, title_size, f"{fam}-ink", align, "600", maxw=maxw)
            ty += title_size * 1.35
        if sub:
            self.text(cx, ty, sub, size - 1, "muted", align, maxw=maxw)
            ty += (size - 1) * 1.4
        for r in rows:
            self.text(cx, ty, r, size, row_cls or "", align, mono=mono_rows, maxw=maxw)
            ty += size * 1.4
        return ty

    def arrow(self, pts, fam="slate", dashed=False, head=True, both=False, width=None):
        d = "M" + " L".join(f"{x:g} {y:g}" for x, y in pts)
        cls = f"{fam}-dash" if dashed else f"{fam}-line"
        if fam == "muted":
            cls = "muted-line"
        marker = f' marker-end="url(#ah-{fam})"' if head else ""
        if both:
            marker += f' marker-start="url(#as-{fam})"'
        style = f' style="stroke-width:{width}"' if width else ""
        self.raw(f'<path d="{d}" class="{cls}"{marker}{style}/>')

    def curve(self, d, fam="slate", dashed=False, head=True):
        cls = f"{fam}-dash" if dashed else f"{fam}-line"
        marker = f' marker-end="url(#ah-{fam})"' if head else ""
        self.raw(f'<path d="{d}" class="{cls}"{marker}/>')

    # ---- output -----------------------------------------------------------
    def _defs(self) -> str:
        out = []
        for f in FAMILIES + ("muted",):
            mark = "muted-mark" if f == "muted" else f"{f}-stroke"
            out.append(
                f'<marker id="ah-{f}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" '
                f'markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0 L10 5 L0 10 z" class="{mark}"/></marker>'
            )
            out.append(
                f'<marker id="as-{f}" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="9" markerHeight="9" '
                f'markerUnits="userSpaceOnUse" orient="auto"><path d="M10 0 L0 5 L10 10 z" class="{mark}"/></marker>'
            )
        return "<defs>" + "".join(out) + "</defs>"

    def render(self, theme: str) -> str:
        head = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.width} {self.height}" '
            f'width="{self.width}" height="{self.height}" role="img" aria-labelledby="t d">\n'
            f'<title id="t">{escape(self.title)}</title>\n<desc id="d">{escape(self.desc)}</desc>\n'
            f"<style>\n{stylesheet(theme)}\n</style>\n{self._defs()}\n"
            f'<rect class="bg frame" x="0.5" y="0.5" width="{self.width - 1}" height="{self.height - 1}" rx="12"/>\n'
        )
        return head + "\n".join(self.items) + "\n</svg>\n"

    def save(self, outdir: str) -> list[str]:
        path = os.path.join(outdir, f"{self.name}.svg")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(self.render("light"))
        paths = [path]
        for w in self.warnings:
            print(f"  [{self.name}] {w}")
        return paths
