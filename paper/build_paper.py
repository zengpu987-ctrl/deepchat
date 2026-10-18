#!/usr/bin/env python3
"""Fill the Nature-style template from measurements and references, then render HTML.

References are numbered by first citation (Nature convention), even though the
JSON is stored thematically. `SEMANTIC` maps the short tokens used in the prose
to the canonical reference ids.
"""
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TEMPLATE = ROOT / "template.html"
OUT = ROOT / "paper.html"

SEMANTIC = {
    "attention": "ref-01", "scalinglaws": "ref-02", "gpt3": "ref-03",
    "instructgpt": "ref-04", "constitutional": "ref-05", "dpo": "ref-06",
    "deepseekcoder": "ref-07", "v2": "ref-08", "v3": "ref-09", "r1": "ref-10",
    "cot": "ref-11", "selfconsistency": "ref-12", "gpt4": "ref-13",
    "o1": "ref-14", "gpt5": "ref-15", "snell": "ref-16", "s1": "ref-17",
    "llmjudge": "ref-18", "lostmiddle": "ref-19", "react": "ref-20",
    "toolformer": "ref-21", "frugalgpt": "ref-22", "routellm": "ref-23",
    "amershi": "ref-24", "nielsen": "ref-25", "shneiderman": "ref-26",
    "luger": "ref-27", "cognitiveload": "ref-28", "localfirst": "ref-29",
    "wcag": "ref-30", "aria": "ref-31", "wkwebview": "ref-32",
    "webkitcookie": "ref-33", "electron": "ref-34", "rfc6265": "ref-35",
    "rfc6750": "ref-36", "rfc6749": "ref-37", "sse": "ref-38",
    "fetch": "ref-39", "mathml": "ref-40", "commonmark": "ref-41",
    "katex": "ref-42", "promptinjection": "ref-43", "owaspasvs": "ref-44",
    "owaspxss": "ref-45", "sameorigin": "ref-46", "codex": "ref-47",
    "chatgptdesktop": "ref-48", "openwebui": "ref-49", "librechat": "ref-50",
    "jan": "ref-51", "ollama": "ref-52", "lmstudio": "ref-53",
    "chatbox": "ref-54", "deepseekapi": "ref-55", "anthropicthinking": "ref-56",
    "mathjax": "ref-57", "webkitstorage": "ref-58",
}

METRICS = {
    "app_size": "1.0 MB",
    "zip_size": "828 KB",
    "ref_count": "58",
    "tests_pipeline": "141",
    "tests_format": "59",
    "ui_trials": "80",
    "effort_mean": "1.4",
    "boot_median": "1.21",
    "newchat_mean": "1.8", "newchat_sd": "0.46", "newchat_p95": "2.5",
    "effort_sd": "0.2", "effort_p95": "1.6",
    "boost_mean": "11.0", "boost_sd": "5.3", "boost_p95": "15.8",
    "model_mean": "5.3", "model_sd": "2.5", "model_p95": "8.0",
    "memory_mean": "0.6", "memory_sd": "0.1", "memory_p95": "0.8",
    "workspace_mean": "1.0", "workspace_sd": "0.2", "workspace_p95": "1.3",
    "account_mean": "1.1", "account_sd": "0.3", "account_p95": "1.5",
    "slider_mean": "118.1", "slider_sd": "6.2", "slider_p95": "127.0",
    "sync_seconds": "11.8",
    "model_previous": "DeepSeek-V41-Flash",
    "model_current": "DeepSeek-V4.1-Flash",
    "port_previous": "127.0.0.1:19387",
    "port_current": "127.0.0.1:53254",
    "effort_levels": "Off, Low, High, Max",
    "hero_size": "30",
}


def ref_html(refs):
    out = []
    for index, ref in enumerate(refs, 1):
        authors = html.escape(ref.get("authors", "").strip())
        title = html.escape(ref.get("title", "").strip())
        venue = html.escape(ref.get("venue", "").strip())
        year = ref.get("year", "")
        url = html.escape(ref.get("url", "").strip())
        if authors and not authors.endswith("."):
            authors += "."
        if title and not title.endswith((".", "?", "!")):
            title += "."
        out.append(
            f'<li id="ref-{index}"><span class="au">{authors}</span> '
            f'<span class="ti">{title}</span> <i>{venue}</i>, <b>{year}</b>. '
            f'<span class="u">{url}</span></li>'
        )
    return "<ol>\n" + "\n".join(out) + "\n</ol>"


def ed_samples_rows(raw):
    labels = [
        ("new_chat_hero", "New chat"), ("effort_open", "Effort card"),
        ("effort_bolt", "Boost"), ("effort_model_menu", "Model menu"),
        ("pill_pressed", "Memory"), ("workspace_card", "Workspace"),
        ("account_card", "Account"), ("slider_drag_max", "Drag to max"),
    ]
    rows = []
    for key, label in labels:
        samples = [float(v) for v in raw["results"][key]["samples"]]
        cells = "".join(f'<td class="num">{v:.2f}</td>' for v in samples)
        mean = sum(samples) / len(samples)
        sd = (sum((v - mean) ** 2 for v in samples) / len(samples)) ** 0.5
        rows.append(f'<tr><td>{label}</td>{cells}<td class="num">{mean:.2f}</td><td class="num">{sd:.2f}</td></tr>')
    return "\n".join(rows)


def main():
    refs = json.loads((ROOT / "data" / "references.json").read_text())
    by_id = {ref["id"]: ref for ref in refs}
    raw = json.loads((ROOT / "data" / "ui-raw.json").read_text())
    text = TEMPLATE.read_text()

    missing_map = sorted({m.group(1) for m in re.finditer(r"\{\{c:([a-z0-9_]+)\}\}", text)} - set(SEMANTIC))
    if missing_map:
        raise SystemExit(f"citation keys without a mapping: {missing_map}")
    missing_refs = sorted({SEMANTIC[k] for k in SEMANTIC} - set(by_id))
    if missing_refs:
        raise SystemExit(f"mapped reference ids missing from JSON: {missing_refs}")

    # Number references by first citation, Nature style.
    order = []
    for match in re.finditer(r"\{\{c:([a-z0-9_]+)\}\}", text):
        key = match.group(1)
        rid = SEMANTIC[key]
        if rid not in order:
            order.append(rid)
    ordered = [by_id[rid] for rid in order]
    number = {ref["id"]: index + 1 for index, ref in enumerate(ordered)}
    text = re.sub(r"\{\{c:([a-z0-9_]+)\}\}", lambda m: str(number[SEMANTIC[m.group(1)]]), text)

    METRICS["ref_count"] = str(len(ordered))
    for key, value in METRICS.items():
        text = text.replace("{{" + key + "}}", value)

    text = text.replace("<!--REFERENCES-->", ref_html(ordered))
    if "<!--ED_SAMPLES-->" in text:
        text = text.replace("<!--ED_SAMPLES-->", ed_samples_rows(raw))

    leftovers = sorted(set(re.findall(r"\{\{[^}]+\}\}", text)))
    if leftovers:
        raise SystemExit(f"unfilled placeholders: {leftovers[:10]}")
    if len(ordered) < 40:
        raise SystemExit(f"only {len(ordered)} cited references")

    OUT.write_text(text)
    print(f"wrote {OUT} ({len(text):,} bytes); {len(ordered)} references cited, {len(refs)} available")


if __name__ == "__main__":
    main()
