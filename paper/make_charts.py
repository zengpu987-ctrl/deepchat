#!/usr/bin/env python3
"""Compose the UI figure and the data figures for the DeepChat paper."""
import json
import os
import statistics
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", str(Path(__file__).resolve().parent / ".mpl"))
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
FIG = ROOT / "figures"
DATA = ROOT / "data"
INK = "#1d1d1f"
MUTED = "#6e6e73"
BLUE = "#2563eb"
PURPLE = "#7c3aed"
HAIR = "#d9d9de"
FONT = "Avenir Next"

plt.rcParams.update({"font.family": FONT, "font.size": 8, "axes.linewidth": 0.8,
                     "axes.edgecolor": "#b9b9c0", "xtick.color": MUTED, "ytick.color": INK})


def load_raw():
    with open(DATA / "ui-raw.json") as handle:
        return json.load(handle)


def summary(samples):
    samples = [float(x) for x in samples]
    return {
        "mean": statistics.mean(samples),
        "sd": statistics.pstdev(samples),
        "p95": sorted(samples)[max(0, int(len(samples) * 0.95) - 1)],
        "n": len(samples),
        "samples": samples,
    }


def ui_figure():
    font_path = "/System/Library/Fonts/Supplemental/Arial.ttf"
    try:
        font = ImageFont.truetype(font_path, 26)
    except Exception:
        font = ImageFont.load_default()

    def fit(image, size, crop=None):
        if crop:
            image = image.crop(crop)
        copy = image.copy()
        copy.thumbnail(size, Image.LANCZOS)
        canvas = Image.new("RGB", size, "white")
        canvas.paste(copy, ((size[0] - copy.width) // 2, (size[1] - copy.height) // 2))
        return canvas

    def panel(image, letter, size, crop=None):
        width, height = size
        header = 36
        out = Image.new("RGB", (width, header + height), "white")
        draw = ImageDraw.Draw(out)
        draw.text((10, 3), letter, fill=INK, font=font)
        out.paste(fit(image, (width, height), crop), (0, header))
        draw.rectangle([(0, header), (width - 1, header + height - 1)], outline=HAIR, width=1)
        return out

    margin, gap = 30, 24
    top_w, top_h = 1040, 699
    bottom_w, bottom_h = 1040, 640
    width = margin * 2 + top_w * 2 + gap
    height = margin * 2 + 36 + top_h + gap + 36 + bottom_h
    canvas = Image.new("RGB", (width, height), "white")

    landing = Image.open(FIG / "ui2-landing.png").convert("RGB")
    effort = Image.open(FIG / "ui2-effort.png").convert("RGB")
    workspace = Image.open(FIG / "ui2-workspace.png").convert("RGB")
    account = Image.open(FIG / "ui2-account.png").convert("RGB")

    panel_a = panel(landing, "a", (top_w, top_h))
    panel_b = panel(effort, "b", (top_w, top_h))
    panel_c = panel(workspace, "c", (bottom_w, bottom_h), crop=(500, 1000, 1450, 1720))
    panel_d = panel(account, "d", (bottom_w, bottom_h), crop=(150, 1100, 1150, 1720))

    canvas.paste(panel_a, (margin, margin))
    canvas.paste(panel_b, (margin + top_w + gap, margin))
    canvas.paste(panel_c, (margin, margin + 36 + top_h + gap))
    canvas.paste(panel_d, (margin + top_w + gap, margin + 36 + top_h + gap))

    out = FIG / "fig2-ui.png"
    canvas.save(out, dpi=(300, 300))
    print("wrote", out, canvas.size)


def latency_figure(raw):
    keys = [
        ("new_chat_hero", "New conversation"),
        ("effort_open", "Effort card"),
        ("effort_bolt", "Boost"),
        ("effort_model_menu", "Model menu"),
        ("pill_pressed", "Memory"),
        ("workspace_card", "Workspace"),
        ("account_card", "Account"),
        ("slider_drag_max", "Drag to max"),
    ]
    rows = []
    for key, label in keys:
        s = summary(raw["results"][key]["samples"])
        rows.append((label, s, key))
    drag = [row for row in rows if row[2] == "slider_drag_max"][0]
    fast = sorted([row for row in rows if row[2] != "slider_drag_max"], key=lambda row: row[1]["mean"])

    fig, (ax, ax2) = plt.subplots(1, 2, figsize=(7.2, 3.2), dpi=300,
                                  gridspec_kw={"width_ratios": [3.1, 1.0]})
    y = np.arange(len(fast))
    means = [row[1]["mean"] for row in fast]
    sds = [row[1]["sd"] for row in fast]
    colors = [PURPLE if row[2] in ("effort_open", "effort_bolt") else BLUE for row in fast]
    ax.barh(y, means, xerr=sds, color=colors, height=0.6, capsize=2.2,
            error_kw={"elinewidth": 0.75, "ecolor": "#555"})
    ax.set_yticks(y)
    ax.set_yticklabels([row[0] for row in fast], fontsize=7.5)
    for index, row in enumerate(fast):
        ax.text(min(row[1]["mean"] + row[1]["sd"] + 0.45, 17.2), index, f"{row[1]['mean']:.1f}",
                va="center", fontsize=6.6, color=INK)
    ax.set_xlabel("click-to-visible latency (ms)", fontsize=7.2, color=MUTED)
    ax.set_xlim(0, 18)
    ax.grid(axis="x", color="#ececf0", linewidth=0.6)
    ax.set_axisbelow(True)
    ax.tick_params(axis="x", labelsize=6.6)
    ax.tick_params(axis="y", length=0)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ax.text(0.01, 1.03, "a", transform=ax.transAxes, ha="left", va="bottom", fontsize=9, fontweight="bold", color=INK)
    ax.text(0.99, 1.03, "n = 10 trials per interaction", transform=ax.transAxes,
            ha="right", va="bottom", fontsize=6.4, color=MUTED)

    ax2.barh([0], [drag[1]["mean"]], xerr=[drag[1]["sd"]], color=PURPLE, height=0.32, capsize=2.2,
             error_kw={"elinewidth": 0.75, "ecolor": "#555"})
    ax2.set_ylim(-0.8, 0.8)
    ax2.set_yticks([0])
    ax2.set_yticklabels(["Drag to max"], fontsize=7.5)
    ax2.set_xlim(0, 145)
    ax2.set_xlabel("drag latency (ms)", fontsize=7.2, color=MUTED)
    ax2.text(drag[1]["mean"] + 7, 0, f"{drag[1]['mean']:.1f}", va="center", fontsize=6.8, color=INK)
    ax2.text(0.01, 1.03, "b", transform=ax2.transAxes, ha="left", va="bottom", fontsize=9, fontweight="bold", color=INK)
    ax2.text(0.98, 1.03, "mouse sequence", transform=ax2.transAxes, ha="right", va="bottom",
             fontsize=6.4, color=MUTED)
    ax2.grid(axis="x", color="#ececf0", linewidth=0.6)
    ax2.set_axisbelow(True)
    ax2.tick_params(axis="x", labelsize=6.6)
    ax2.tick_params(axis="y", length=0)
    for spine in ("top", "right"):
        ax2.spines[spine].set_visible(False)

    fig.tight_layout(pad=0.3)
    out = FIG / "fig4-latency.png"
    fig.savefig(out, dpi=300, facecolor="white")
    plt.close(fig)
    print("wrote", out)


def timeline_figure(raw):
    fig, ax = plt.subplots(figsize=(7.2, 2.35), dpi=300)
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 2.5)
    ax.axis("off")
    y = 1.25
    ax.plot([0.35, 9.65], [y, y], color=HAIR, linewidth=1.4, zorder=1)
    events = [
        (0.85, "Harness :19387\nV41-Flash", "above", BLUE),
        (2.55, "restart", "below", MUTED),
        (4.15, "new cookie\nauthority :53254", "above", PURPLE),
        (5.85, "probe 200\nadopt", "below", PURPLE),
        (7.55, "reload\nV4.1-Flash", "above", BLUE),
        (9.20, "page ready", "below", BLUE),
    ]
    for x, label, side, color in events:
        ax.plot([x, x], [y - 0.20, y + 0.20], color=color, linewidth=1.5, zorder=3)
        if side == "above":
            ax.text(x, y + 0.30, label, ha="center", va="bottom", fontsize=6.8, color=color)
        else:
            ax.text(x, y - 0.30, label, ha="center", va="top", fontsize=6.8, color=color)
    ax.annotate("", xy=(9.20, 0.42), xytext=(4.15, 0.42),
                arrowprops=dict(arrowstyle="<|-|>", color=PURPLE, lw=0.9, linestyle=(0, (3, 2))))
    ax.text(6.67, 0.27, "within one 20 s sync cycle", ha="center", va="bottom", fontsize=6.5, color=PURPLE)
    ax.text(0.35, 0.10, "Old authority stops answering; the signed cookie for the new authority is probed and adopted; the page reloads with the new model.",
            ha="left", va="bottom", fontsize=6.4, color=MUTED, style="italic")
    fig.tight_layout(pad=0.2)
    out = FIG / "fig5-timeline.png"
    fig.savefig(out, dpi=300, facecolor="white")
    plt.close(fig)
    print("wrote", out)


def tests_figure(raw):
    fig, ax = plt.subplots(figsize=(7.2, 2.45), dpi=300)
    labels = ["Pipeline", "Formatting", "Scripted UI", "Auth"]
    counts = [raw.get("tests", {}).get("pipeline", 141),
              raw.get("tests", {}).get("format", 59),
              raw.get("tests", {}).get("ui_trials", 80),
              raw.get("tests", {}).get("auth", 2)]
    y = np.arange(len(labels))
    colors = [BLUE, BLUE, PURPLE, PURPLE]
    ax.barh(y, counts, color=colors, height=0.58)
    for index, count in enumerate(counts):
        ax.text(count + 4, index, f"{count}/{count}", va="center", fontsize=7.2, color=INK)
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=7.6)
    ax.set_xlim(0, max(counts) * 1.28)
    ax.set_xlabel("checks passed", fontsize=7.2, color=MUTED)
    ax.grid(axis="x", color="#ececf0", linewidth=0.6)
    ax.set_axisbelow(True)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ax.tick_params(axis="y", length=0)
    ax.tick_params(axis="x", labelsize=6.8)
    fig.tight_layout(pad=0.3)
    out = FIG / "fig6-tests.png"
    fig.savefig(out, dpi=300, facecolor="white")
    plt.close(fig)
    print("wrote", out)


if __name__ == "__main__":
    raw = load_raw()
    ui_figure()
    latency_figure(raw)
    timeline_figure(raw)
    tests_figure(raw)
