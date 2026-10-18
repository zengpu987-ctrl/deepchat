# DeepChat UI measurements

Generated 2026-10-19T04:16:31.415+08:00 from the live Harness Web GUI at [http://127.0.0.1:53254/](http://127.0.0.1:53254/).
Browser: Google Chrome for Testing 152.0.7977.64, headless, viewport 1280x860 (deviceScaleFactor 1).
The DSH sidebar is hidden with the same grid override the desktop app applies (`gridTemplateColumns = '0px minmax(0, 1fr) 0px'`, sidebar column width 0, frame handle hidden).

## Interaction latency

Each interaction ran 10 times. The page-side clock starts immediately before `element.click()` and stops at the first
`requestAnimationFrame` in which the target condition holds (one frame resolution). Times are milliseconds.

| Interaction | n | Mean | SD | p95 | Min | Max |
|---|---:|---:|---:|---:|---:|---:|
| new-chat click -> .cm_heroTitle visible | 10 | 1.80 | 0.46 | 2.52 | 1.30 | 2.70 |
| .cm_effortBtn click -> .cm_effortCard visible | 10 | 1.38 | 0.15 | 1.60 | 1.10 | 1.60 |
| .cm_effortBolt click -> .cm_effortName becomes Max | 10 | 11.04 | 5.29 | 15.80 | 1.50 | 15.80 |
| .cm_effortModelBtn click -> .cm_brandMenu visible | 10 | 5.28 | 2.46 | 8.02 | 1.30 | 8.20 |
| .cm_pillAction click -> aria-pressed flips | 10 | 0.63 | 0.12 | 0.81 | 0.50 | 0.90 |
| .cm_contextChipButton click -> .cm_workspaceCard visible | 10 | 0.98 | 0.20 | 1.26 | 0.70 | 1.40 |
| .cm_accountBtn click -> .cm_accountCard visible | 10 | 1.06 | 0.26 | 1.48 | 0.80 | 1.70 |
| mouse drag slider to last stop -> .cm_effortName becomes Max | 10 | 118.10 | 6.24 | 126.99 | 109.00 | 134.10 |

Method notes: React flushes discrete click updates synchronously, and headless Chrome schedules the first animation
frame within about a millisecond, so most results measure click -> DOM-visible rather than compositor paint (the
slider drag is the exception because it follows a real pointer gesture). The slider was dragged from the current
thumb position to the right end in 12 mouse-move steps; the clock runs from `mousedown` to the frame where the
label reads **Max**.

- New chat was measured from an open conversation (the landing hero absent before the click).
- Bolt and slider trials reset the effort to the default (High) first; all ten bolt trials transitioned High -> Max.
- The memory pill alternated true -> false and false -> true in all ten trials.
- Overlays were closed with Escape between trials; no trial reported a missing selector or timeout.

## Boot

Five fresh browser contexts, each with the 53254 cookie. Wall-clock from before `page.goto` (waitUntil
domcontentloaded) until
`[data-chat-mode]` is present plus a 500 ms settle.

| Round | To panel (ms) | Boot incl. settle (ms) |
|---:|---:|---:|
| 1 | 708 | 1210 |
| 2 | 686 | 1188 |
| 3 | 1259 | 1761 |
| 4 | 701 | 1203 |
| 5 | 728 | 1230 |

**Median boot: 1210 ms** (mean 1318.40 ms, SD 247.88 ms, min 1188 ms, max 1761 ms).
Median time to the panel before the 500 ms settle: 708 ms.

## Model catalog

Opened with `.cm_brandBtn`; groups and items read from `.cm_menuGroup` / `.cm_menuItem`.

| Group | Items |
|---|---|
| DeepSeek | **DeepSeek-V4.1-Flash** (checked), DeepSeek-V4-Pro |
| DeepSeek Account | DeepSeek-V4.1-Flash, DeepSeek-V4-Pro |

Current selection: **DeepSeek-V4.1-Flash** (the checked item is in the first group, DeepSeek).

## Thinking effort

Opened with `.cm_effortBtn`; the current label is in `.cm_effortName`, the range input has min 0 /
max 3 and currently sits at 2 (High). Walking all four stops gives:

| Index | Label |
|---:|---|
| 0 | Off |
| 1 | Low |
| 2 | High (current) |
| 3 | Max |

The bolt toggles the top stop: every trial moved High -> **Max** (and back to the default on reset). The slider is the
same control, driven by a real mouse drag.

## Auth

| Request | Status |
|---|---:|
| `curl http://127.0.0.1:53254/` with the 53254 cookie | 200 |
| same URL without a cookie | 401 |

The cookie was selected by decoding the JWT payload and matching authority `127.0.0.1:53254` (the other stored
cookie belongs to the stale 19387 authority).

## Test suites

| Suite | Exit | `ok` lines |
|---|---:|---:|
| `node tools/chat-mode-check.mjs` | 0 | 141 |
| `node tools/chat-mode-format-check.mjs` | 0 | 59 |

Both suites ended with `all checks passed`.

## File metrics

| File | Lines | Bytes |
|---|---:|---:|
| `chat-mode/client.js` | 5539 | 241102 |
| `chat-mode/index.js` | 255 | 10087 |
| `deepchat-app/src/main.swift` | 954 | 42346 |
| **Total** | **6748** | |

- `/Applications/DeepChat.app`: 1.0M (1036 KiB).
- `deepchat-app/dist/DeepChat-1.2.0.zip`: 828K, 846594 bytes.
- Dictionaries: **2** locale dictionaries (zh, en) with **99** UI strings each; the key sets match. The two
  `locale/*.json` manifest files carry one `meta` entry each.

## Sync detection

The installed app polls the served page every 20 s. After noting the log length, `touch chat-mode/client.js`
was run and `~/Library/Logs/DeepChat.log` was polled every 0.5 s for a new line containing
`Harness page revision changed` or `didFinish`.

| Trial | Detected after |
|---|---:|
| 1 | 11.79 s |
| 2 | 11.35 s |

Both trials detected `[DeepChat] Harness page revision changed; reloading`; the observed latency is consistent
with a 20 s timer and an arbitrary phase (0-20 s).

## Console and page errors

| Message | Occurrences | Contexts |
|---|---:|---|
| Error: Minified React error #130; visit https://reactjs.org/docs/error-decoder.html?invariant=130&args[]=undefined&args[]= for the full message or use the non-minified dev environment for full errors and additional helpf | 6 | boot-1, boot-2, boot-3, boot-4, boot-5, interaction |
| slot entry crashed in 'sidebar.footer.action': Error: Minified React error #130; visit https://reactjs.org/docs/error-decoder.html?invariant=130&args[]=undefined&args[]= for the full message or use the non-minified dev e | 6 | boot-1, boot-2, boot-3, boot-4, boot-5, interaction |

Both messages are the DSH shell's `sidebar.footer.action` slot crashing with React error #130. They appeared once
per fresh page (all five boot contexts plus the interaction page) and did not prevent the DeepChat panel from
rendering. There were no `pageerror` events and no failed requests in any measurement context.

## Figures

- [ui-landing.png](../figures/ui-landing.png) - landing state, DSH sidebar hidden.
- [ui-effort.png](../figures/ui-effort.png) - effort popover at the default High stop.
- [ui-model.png](../figures/ui-model.png) - model catalog open.

Raw browser run: [ui-raw.json](ui-raw.json). Machine-readable metrics: [metrics.json](metrics.json).
