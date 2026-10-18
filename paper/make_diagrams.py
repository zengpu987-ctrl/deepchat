#!/usr/bin/env python3
"""Draw the DeepChat architecture and authentication/sync sequence figures."""
import os
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", str(Path(__file__).resolve().parent.parent / ".mpl"))
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Rectangle

INK = "#1d1d1f"
MUTED = "#6e6e73"
LINE = "#d2d2d7"
BLUE = "#2563eb"
PURPLE = "#7c3aed"
PANEL = "#f7f7f9"
FONT = "Avenir Next"

plt.rcParams.update({
    "font.family": FONT,
    "font.size": 9,
    "axes.linewidth": 0,
})


def box(ax, x, y, w, h, title, lines=(), fill="white", edge=LINE, title_color=INK,
        title_size=9.2, body_size=7.6, lw=1.0):
    patch = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.02,rounding_size=0.12",
                           linewidth=lw, edgecolor=edge, facecolor=fill, zorder=2)
    ax.add_patch(patch)
    ax.text(x + w / 2, y + h - 0.22, title, ha="center", va="top", fontsize=title_size,
            fontweight="semibold", color=title_color, zorder=3)
    for index, line in enumerate(lines):
        ax.text(x + w / 2, y + h - 0.52 - index * 0.25, line, ha="center", va="top",
                fontsize=body_size, color=MUTED, zorder=3)
    return patch


def arrow(ax, start, end, label="", color=INK, curve=0.0, style="-|>", lw=1.1,
          label_offset=(0, 0.12), fontsize=7.2, linestyle="-"):
    arrow_patch = FancyArrowPatch(start, end, arrowstyle=style, mutation_scale=10,
                                  linewidth=lw, color=color, connectionstyle=f"arc3,rad={curve}",
                                  zorder=4, linestyle=linestyle)
    ax.add_patch(arrow_patch)
    if label:
        mx = (start[0] + end[0]) / 2 + label_offset[0]
        my = (start[1] + end[1]) / 2 + label_offset[1]
        ax.text(mx, my, label, ha="center", va="bottom", fontsize=fontsize, color=color,
                bbox=dict(boxstyle="round,pad=0.15", facecolor="white", edgecolor="none", alpha=0.9),
                zorder=5)


def architecture():
    (Path(__file__).resolve().parent / "figures").mkdir(exist_ok=True)
    fig, ax = plt.subplots(figsize=(12.2, 7.0), dpi=300)
    ax.set_xlim(0, 12.2)
    ax.set_ylim(0, 6.9)
    ax.axis("off")

    panels = [
        (0.25, 3.55, "macOS shell  ·  Swift + WKWebView"),
        (3.80, 3.55, "DeepChat browser half  ·  React"),
        (7.35, 3.55, "DeepSeek Harness Host  ·  Node"),
    ]
    for x, w, title in panels:
        ax.add_patch(FancyBboxPatch((x, 0.35), w, 5.9, boxstyle="round,pad=0.03,rounding_size=0.18",
                                    linewidth=1.0, edgecolor=LINE, facecolor=PANEL, zorder=1))
        ax.text(x + 0.14, 5.98, title, ha="left", va="center", fontsize=9.6,
                fontweight="semibold", color=INK)

    box(ax, 0.45, 4.62, 3.10, 1.02, "Native window & menu",
        ["WKWebView, file picker, external links", "Cmd+R reload · Harness Settings"], fill="white")
    box(ax, 0.45, 3.38, 3.10, 0.98, "Authority discovery",
        ["reads Chromium cookie DB; decodes signed payload", "authority 127.0.0.1:<port>; probe newest-first"], fill="white")
    box(ax, 0.45, 2.14, 3.10, 0.98, "20 s sync watcher",
        ["GET / with cookie · compare HTML revision", "reload when idle; refresh on 401/port change"], fill="white")
    box(ax, 0.45, 0.76, 3.10, 1.04, "Bootstrap HTTP :ephemeral",
        ["302 Set-Cookie (HttpOnly) + Location", "solves WKWebView IP-literal cookie quirk"], fill="white")

    box(ax, 4.00, 4.62, 3.10, 1.02, "Codex-style interface",
        ["rail · hero · wide composer · account", "purple effort popover · workspace menu"], fill="white")
    box(ax, 4.00, 3.38, 3.10, 0.98, "Chat controller",
        ["localStorage history + memory mirror", "streaming, stop, attachments, math"], fill="white")
    box(ax, 4.00, 2.14, 3.10, 0.98, "Model catalog mirror",
        ["DeepSeek-V4.1-Flash / V4-Pro", "4 effort stops · focus + 90 s refresh"], fill="white")
    box(ax, 4.00, 0.76, 3.10, 1.04, "Sync & error boundaries",
        ["data/render normalisation", "crash card, pointer/keyboard parity"], fill="white")

    box(ax, 7.55, 4.62, 3.10, 1.02, "HTTP + SSE route",
        ["POST /api/chat-mode/stream", "text / reasoning deltas"], fill="white")
    box(ax, 7.55, 3.38, 3.10, 0.98, "LLM adapters",
        ["DeepSeek official / account", "provider + model routing"], fill="white")
    box(ax, 7.55, 2.14, 3.10, 0.98, "Catalog & settings",
        ["models, reasoning efforts, default", "credentials, workspace, tools"], fill="white")
    box(ax, 7.55, 0.76, 3.10, 1.04, "Signed session cookie",
        ["dsh-auth-… · authority-bound", "read by the macOS shell"], fill="white")

    # Only adjacent-panel arrows; cross-layer behaviour is stated in the note
    # band above the panels, so no label is buried under a box.
    arrow(ax, (7.10, 4.95), (7.55, 4.95), "SSE deltas", color=BLUE,
          label_offset=(0, 0.10), fontsize=7.0)
    arrow(ax, (7.55, 4.55), (7.10, 4.55), "modelCatalog RPC", color=BLUE,
          label_offset=(0, -0.28), fontsize=7.0)
    arrow(ax, (4.00, 5.12), (3.55, 5.12), "WKWebView", color=BLUE,
          label_offset=(0, 0.10), fontsize=7.0)
    arrow(ax, (3.55, 0.98), (4.00, 0.98), "302 + Set-Cookie", color=PURPLE,
          label_offset=(0, -0.30), fontsize=7.0)
    # 20 s sync band above the three panels
    ax.annotate("", xy=(10.35, 6.36), xytext=(1.85, 6.36),
                arrowprops=dict(arrowstyle="<|-|>", color=INK, lw=1.1, linestyle=(0, (3, 2))))
    ax.text(6.1, 6.44, "shell sync: every 20 s  GET / with cookie -> compare HTML revision & authority",
            ha="center", va="bottom", fontsize=7.6, color=INK,
            bbox=dict(boxstyle="round,pad=0.2", facecolor="white", edgecolor="none"))

    ax.text(6.1, 0.10, "All traffic stays on loopback. The browser never receives a provider credential; the shell never receives model output. The shell reads the signed cookie DB (Chromium profile) to learn the current 127.0.0.1:<port>.",
            ha="center", va="bottom", fontsize=7.2, color=MUTED, style="italic")
    fig.tight_layout(pad=0.1)
    out = Path(__file__).resolve().parent / "figures" / "fig1-architecture.png"
    fig.savefig(out, dpi=300, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print("wrote", out)


def sequence():
    (Path(__file__).resolve().parent / "figures").mkdir(exist_ok=True)
    fig, ax = plt.subplots(figsize=(12.2, 6.6), dpi=300)
    ax.set_xlim(0, 12.2)
    ax.set_ylim(0, 7.2)
    ax.axis("off")
    lanes = [
        (1.3, "macOS shell"),
        (3.6, "Bootstrap\n:ephemeral"),
        (5.9, "WKWebView"),
        (8.3, "Harness Host"),
        (10.7, "Cookie DB"),
    ]
    for x, label in lanes:
        ax.plot([x, x], [0.55, 6.55], color=LINE, lw=1.0, zorder=1)
        ax.text(x, 6.72, label, ha="center", va="bottom", fontsize=8.8, fontweight="semibold", color=INK)
        ax.add_patch(Rectangle((x - 0.55, 6.28), 1.1, 0.26, facecolor=PANEL, edgecolor=LINE, lw=0.8, zorder=2))

    def msg(y, a, b, text, color=INK, dashed=False):
        ax.annotate("", xy=(b, y), xytext=(a, y),
                    arrowprops=dict(arrowstyle="-|>", color=color, lw=1.0,
                                    linestyle=(0, (3, 2)) if dashed else "-", shrinkA=2, shrinkB=2))
        ax.text((a + b) / 2, y + 0.10, text, ha="center", va="bottom", fontsize=7.2, color=color,
                bbox=dict(boxstyle="round,pad=0.15", facecolor="white", edgecolor="none", alpha=0.9))

    msg(5.95, 10.7, 1.3, "1  read cookies; decode authority")
    msg(5.55, 1.3, 8.3, "2  GET / (Cookie) -> 200")
    msg(5.15, 1.3, 5.9, "3  load http://127.0.0.1:<ephemeral>/")
    msg(4.75, 5.9, 3.6, "4  GET /bootstrap")
    msg(4.35, 3.6, 5.9, "5  302 Set-Cookie + Location (Harness)", color=PURPLE)
    msg(3.95, 5.9, 8.3, "6  GET / (Cookie) -> app HTML/JS", color=BLUE)
    msg(3.55, 5.9, 8.3, "7  POST /api/chat-mode/stream (SSE)", color=BLUE)
    msg(3.15, 5.9, 8.3, "8  modelCatalog RPC (WebSocket)", color=BLUE)
    msg(2.65, 1.3, 8.3, "9  every 20 s: GET / (Cookie) -> HTML", dashed=True)
    msg(2.25, 8.3, 10.7, "10  Harness restart -> new port + cookie", color=PURPLE, dashed=True)
    msg(1.85, 1.3, 8.3, "11  rediscover β -> adopt -> reload", color=PURPLE)

    ax.text(6.1, 0.15, "Numbers 1–11 are the real launch/reconnect path. The signed cookie names its authority, so a port change is recoverable without configuration.",
            ha="center", va="bottom", fontsize=7.4, color=MUTED, style="italic")
    fig.tight_layout(pad=0.1)
    out = Path(__file__).resolve().parent / "figures" / "fig3-sequence.png"
    fig.savefig(out, dpi=300, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print("wrote", out)


if __name__ == "__main__":
    architecture()
    sequence()
