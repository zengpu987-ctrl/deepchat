# DeepChat paper — Nature-style bilingual preprint

This directory contains the 18-page, English/Chinese, Nature-style preprint
**DeepChat: a local-first, model-synchronising macOS client for
reasoning-effort-controlled conversational AI**.

- `DeepChat-Nature-Bilingual-18p.pdf` — the deliverable, exactly 18 A4 pages.
  English pp. 1–10, 中文 pp. 11–14, Extended Data pp. 15–16, references and
  back matter pp. 17–18.
- `template.html` — the editable source (Nature-style CSS, bilingual text,
  placeholders such as `{{c:v3}}` and `{{ui_trials}}`).
- `data/references.json` — 58 references, verified and numbered by first
  citation at build time.
- `data/metrics.json`, `data/ui-raw.json` — the measurements and the raw
  browser samples behind Table 3 and Extended Data Table 1.
- `figures/` — the seven figures used in the PDF.
- `build_paper.py` — fills citations/metrics and writes `paper.html`.
- `make_diagrams.py`, `make_charts.py`, `make_extended.py` — regenerate
  figures from the data (matplotlib).
- `render_pdf.mjs` — Chromium print-to-PDF (playwright-core).
- `collect-ui.mjs` — optional live measurement harness. It needs a running
  DeepSeek Harness, a logged-in desktop profile and a Chrome binary.

## Rebuild

```sh
cd paper
python3 -m pip install matplotlib
npm install playwright-core
python3 make_diagrams.py
python3 make_charts.py
python3 make_extended.py
python3 build_paper.py
node render_pdf.mjs
```

`CHROME_PATH` selects the Chrome/Chromium binary; by default the script uses
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. The PDF is
written to `paper/build/DeepChat-Nature-Bilingual.pdf`.

The measured environment was macOS 26.5, Node 24.19, Python 3.13.5,
Chrome 152 headless, DeepChat 1.2.0, host `127.0.0.1:53254`. Latency values
are exploratory, single-machine observations; no significance tests are
claimed. See the Reporting summary in the PDF.

## Licence

The paper, its figures and tables are licensed CC BY 4.0 (see
`LICENSE-CC-BY-4.0.md`). The code in the repository is MIT.
