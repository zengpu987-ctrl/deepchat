#!/usr/bin/env python3
"""Extended-data figures: sync state machine, trust boundaries, raw trials."""
import json
import os
import statistics
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", str(Path(__file__).resolve().parent / ".mpl"))
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

FIG = Path(__file__).resolve().parent / "figures"
INK = "#1d1d1f"
MUTED = "#6e6e73"
LINE = "#d2d2d7"
BLUE = "#2563eb"
PURPLE = "#7c3aed"
FONT = "Avenir Next"
plt.rcParams.update({"font.family": FONT, "font.size": 8})


def box(ax, x, y, w, h, title, body="", fill="white", edge=LINE, color=INK):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.02,rounding_size=0.08",
                                linewidth=1.0, edgecolor=edge, facecolor=fill, zorder=2))
    ax.text(x + w / 2, y + h / 2 + (0.11 if body else 0), title, ha="center", va="center",
            fontsize=7.6, fontweight="semibold", color=color, zorder=3)
    if body:
        ax.text(x + w / 2, y + h / 2 - 0.18, body, ha="center", va="center", fontsize=6.5,
                color=MUTED, zorder=3)


def arrow(ax, a, b, text="", color=INK, rad=0.0, style="-|>", dashed=False):
    ax.add_patch(FancyArrowPatch(a, b, arrowstyle=style, mutation_scale=9, linewidth=0.95,
                                 color=color, connectionstyle=f"arc3,rad={rad}", zorder=4,
                                 linestyle=(0, (3, 2)) if dashed else "-"))
    if text:
        ax.text((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.11, text, ha="center", va="bottom",
                fontsize=6.2, color=color,
                bbox=dict(boxstyle="round,pad=0.12", facecolor="white", edgecolor="none", alpha=0.92))


def state_machine():
    fig, ax = plt.subplots(figsize=(7.2, 4.3), dpi=300)
    ax.set_xlim(0, 10.3)
    ax.set_ylim(0, 6.0)
    ax.axis("off")
    ax.text(0.1, 5.82, "a", fontsize=10, fontweight="bold", color=INK)

    # top row: the happy path
    box(ax, 0.25, 4.55, 1.95, 0.72, "page ready / idle", "composer empty")
    box(ax, 2.55, 4.55, 1.75, 0.72, "20 s tick", "discover")
    box(ax, 4.65, 4.55, 2.15, 0.72, "discover + fetch", "cookie + HTTP")
    box(ax, 7.15, 4.55, 1.85, 0.72, "revision?", "compare")
    box(ax, 9.30, 4.55, 0.85, 0.72, "reload", "idle", fill="#f5f3ff", edge=PURPLE, color=PURPLE)

    # middle row: branch states
    box(ax, 7.15, 2.95, 1.85, 0.72, "defer", "busy: retry", fill="#fff7ed", edge="#f59e0b", color="#b45309")
    box(ax, 4.65, 2.95, 2.15, 0.72, "rediscover", "401 / new port", fill="#fef2f2", edge="#ef4444", color="#b91c1c")
    box(ax, 2.55, 2.95, 1.75, 0.72, "adopt", "reload page", fill="#f5f3ff", edge=PURPLE, color=PURPLE)

    # bottom row: failure path
    box(ax, 2.55, 1.35, 1.75, 0.72, "3 failures", "no authority")
    box(ax, 4.65, 1.35, 2.15, 0.72, "start Harness / wait", "poll 1 s")
    box(ax, 7.15, 1.35, 1.85, 0.72, "timeout", "retry card")

    arrow(ax, (2.20, 4.91), (2.55, 4.91), "tick")
    arrow(ax, (4.30, 4.91), (4.65, 4.91), "probe")
    arrow(ax, (6.80, 4.91), (7.15, 4.91), "200")
    arrow(ax, (8.08, 4.91), (9.30, 4.91), "changed / idle", color=PURPLE)
    arrow(ax, (8.08, 4.55), (8.08, 3.67), "changed / busy", color="#b45309")
    arrow(ax, (7.85, 3.31), (6.20, 4.55), "retry", color="#b45309", rad=0.25)
    arrow(ax, (7.15, 4.70), (6.80, 3.31), "401 / port", color="#b91c1c", rad=0.12)
    arrow(ax, (4.65, 3.31), (4.30, 3.31), "adopt", color=PURPLE)
    arrow(ax, (3.42, 2.95), (1.22, 4.55), "loaded", color=PURPLE, rad=-0.22)
    arrow(ax, (4.65, 4.70), (4.30, 2.67), "3 failures", color="#b91c1c", rad=0.12)
    arrow(ax, (4.30, 2.31), (3.42, 2.31), "after 3", color="#b91c1c")
    arrow(ax, (4.65, 1.71), (4.30, 1.71), "poll", color="#b45309")
    arrow(ax, (5.72, 2.07), (5.72, 2.95), "auth found", color=PURPLE)
    arrow(ax, (6.80, 1.71), (7.15, 1.71), "45 s", color="#b91c1c")
    arrow(ax, (7.15, 1.71), (4.30, 2.31), "manual retry", color="#b91c1c", rad=-0.12)

    ax.text(0.25, 0.55, "The only state that reloads is 'idle'. A draft, a pending attachment or a streaming answer stalls the reload; the next tick retries. The failure path is bounded at 45 s and then exposes a retry card rather than a blank page.",
            ha="left", va="bottom", fontsize=6.4, color=MUTED, style="italic")
    fig.tight_layout(pad=0.2)
    out = FIG / "figED1-state.png"
    fig.savefig(out, dpi=300, facecolor="white")
    plt.close(fig)
    print("wrote", out)


def trust_boundaries():
    fig, ax = plt.subplots(figsize=(7.2, 4.0), dpi=300)
    ax.set_xlim(0, 10.2)
    ax.set_ylim(0, 5.5)
    ax.axis("off")
    ax.text(0.1, 5.35, "b", fontsize=10, fontweight="bold", color=INK)
    zones = [
        (0.3, "Provider cloud", "provider API key\nmodel weights", "#fef2f2", "#ef4444", "#b91c1c"),
        (2.75, "Harness host", "session key\nmodel routing", "#eff6ff", BLUE, BLUE),
        (5.2, "macOS shell", "cookie DB read\nport discovery", "#f5f3ff", PURPLE, PURPLE),
        (7.65, "WKWebView page", "chat state\nDOM", "#f0fdf4", "#16a34a", "#15803d"),
    ]
    for x, title, body, fill, edge, color in zones:
        ax.add_patch(FancyBboxPatch((x, 2.7), 2.15, 1.55, boxstyle="round,pad=0.04,rounding_size=0.12",
                                    linewidth=1.0, edgecolor=edge, facecolor=fill, zorder=2))
        ax.text(x + 1.07, 3.95, title, ha="center", va="center", fontsize=8.2, fontweight="semibold", color=color, zorder=3)
        ax.text(x + 1.07, 3.35, body, ha="center", va="center", fontsize=6.8, color=INK, zorder=3)
    arrow(ax, (2.45, 3.55), (2.75, 3.55), "HTTPS", color=BLUE)
    arrow(ax, (4.9, 3.55), (5.2, 3.55), "signed cookie", color=PURPLE, dashed=True)
    arrow(ax, (7.35, 3.55), (7.65, 3.55), "302 Set-Cookie", color="#16a34a")
    arrow(ax, (7.65, 3.05), (4.9, 3.05), "SSE / RPC", color=BLUE, rad=0.0)
    arrow(ax, (5.2, 2.85), (2.75, 2.85), "no provider key", color="#b91c1c", dashed=True)
    # assets row
    ax.add_patch(FancyBboxPatch((0.3, 0.55), 9.55, 1.45, boxstyle="round,pad=0.03,rounding_size=0.1",
                                linewidth=0.8, edgecolor=LINE, facecolor="#fafafa", zorder=1))
    ax.text(0.55, 1.72, "What each zone can see", fontsize=7.6, fontweight="semibold", color=INK)
    ax.text(0.55, 1.25, "Provider: API key, model.   Host: model catalogue, credentials, sessions.   Shell: cookie DB, port, HTML revision.   Page: conversation, DOM, HttpOnly cookie (not readable).",
            fontsize=6.5, color=MUTED)
    ax.text(0.55, 0.83, "Residual: a malicious pasted file can still reach the model; a same-user process can read the cookie DB; a third-party page slot can throw (the panel has its own error boundary).",
            fontsize=6.5, color="#b91c1c")
    fig.tight_layout(pad=0.2)
    out = FIG / "figED2-trust.png"
    fig.savefig(out, dpi=300, facecolor="white")
    plt.close(fig)
    print("wrote", out)


def raw_trials():
    raw = json.loads((Path(__file__).resolve().parent / "data" / "ui-raw.json").read_text())
    keys = [("new_chat_hero", "New chat"), ("effort_open", "Effort card"), ("effort_bolt", "Boost"),
            ("effort_model_menu", "Model menu"), ("pill_pressed", "Memory"),
            ("workspace_card", "Workspace"), ("account_card", "Account"),
            ("slider_drag_max", "Drag to max")]
    fig, (ax, ax2) = plt.subplots(1, 2, figsize=(7.2, 3.3), dpi=300,
                                  gridspec_kw={"width_ratios": [2.3, 1.0]})
    fast = [(k, label, raw["results"][k]["samples"]) for k, label in keys if k != "slider_drag_max"]
    for row, (key, label, samples) in enumerate(fast):
        xs = list(samples)
        ax.scatter(xs, [row] * len(xs), s=14, color=PURPLE if "effort" in key else BLUE, alpha=0.75, edgecolors="white", linewidths=0.4, zorder=3)
        ax.plot([statistics.mean(xs)] * 2, [row - 0.18, row + 0.18], color=INK, linewidth=1.1, zorder=4)
    ax.set_yticks(range(len(fast)))
    ax.set_yticklabels([label for _, label, _ in fast], fontsize=7.2)
    ax.set_xlim(0, 18)
    ax.set_xlabel("click-to-visible (ms)", fontsize=7.0, color=MUTED)
    ax.grid(axis="x", color="#ececf0", linewidth=0.6)
    ax.set_axisbelow(True)
    ax.tick_params(axis="x", labelsize=6.4)
    ax.tick_params(axis="y", length=0)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ax.text(0.01, 1.03, "a", transform=ax.transAxes, fontsize=9, fontweight="bold", color=INK)

    drag = raw["results"]["slider_drag_max"]["samples"]
    ax2.scatter(drag, [0] * len(drag), s=18, color=PURPLE, alpha=0.8, edgecolors="white", linewidths=0.4)
    ax2.plot([statistics.mean(drag)] * 2, [-0.25, 0.25], color=INK, linewidth=1.2)
    ax2.set_yticks([0])
    ax2.set_yticklabels(["Drag"], fontsize=7.2)
    ax2.set_ylim(-0.7, 0.7)
    ax2.set_xlim(100, 140)
    ax2.set_xlabel("drag latency (ms)", fontsize=7.0, color=MUTED)
    ax2.grid(axis="x", color="#ececf0", linewidth=0.6)
    ax2.set_axisbelow(True)
    ax2.tick_params(axis="x", labelsize=6.4)
    ax2.tick_params(axis="y", length=0)
    for spine in ("top", "right"):
        ax2.spines[spine].set_visible(False)
    ax2.text(0.01, 1.03, "b", transform=ax2.transAxes, fontsize=9, fontweight="bold", color=INK)
    fig.tight_layout(pad=0.3)
    out = FIG / "figED3-samples.png"
    fig.savefig(out, dpi=300, facecolor="white")
    plt.close(fig)
    print("wrote", out)


if __name__ == "__main__":
    state_machine()
    trust_boundaries()
    raw_trials()
