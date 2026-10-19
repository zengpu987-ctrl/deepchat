# Changelog

## 1.3.0 — 2026-10-20

- Added the **text-to-image modal** to DeepChat and the macOS app: six modes
  (Auto / Photo / Illustration / Poster / Fast / HD), 1:1 / 3:2 / 2:3 aspect
  ratios, and 1/2/4 images.
- Added two engine choices: the Harness `image_generate` tool (after configuring
  a provider and restarting Harness) and a keyless free online channel that
  works immediately.
- Added the native macOS menu **Generate image…** (⌘⇧I); `--image` opens the
  modal in snapshot/debug runs.
- Added authenticated Host routes `/api/chat-mode/image` and
  `/api/chat-mode/image/status`; results from the Harness channel are saved
  under `generate/image`.
- Verification is now 143 pipeline checks + 59 formatting checks.

## 1.2.0 — 2026-10-19

- Added signed-cookie **authority discovery**: decode `authority` from each
  `dsh-auth-…` payload, probe candidates newest-first, adopt the first `200`.
  Recovered a real host restart from `127.0.0.1:19387` to
  `127.0.0.1:53254` with no configuration.
- Followed the live model catalogue from `DeepSeek-V41-Flash` to
  **`DeepSeek-V4.1-Flash`**; `DeepSeek-V4-Pro` remains available in both
  provider groups. New conversations follow the host default.
- Fixed every previously dead click target: the effort-popover model line,
  lightning boost, memory pill, account avatar and workspace chip.
- Effort track now fills purple to the thumb with a flowing gradient and
  drifting stars; the unfilled portion stays white.
- Published the 18-page, Nature-style English/Chinese preprint with 7 figures,
  11 tables and 58 references.
- Added the reproducible paper build (`paper/`), measurement data and figures.

## 1.1.1 — 2026-10-19

- Scoped the launch click to the Harness sidebar entry, so the model menu no
  longer opens at boot.

## 1.1.0 — 2026-10-18

- Codex-shaped surface: 300 px rail, cloud hero, wide composer, purple effort
  popover, workspace and account cards.
- Drag-based reasoning-effort control with a four-stop ladder and reset.
- Native macOS shell with the DeepChat whale icon, 302 cookie bootstrap and
  20 s host-revision watcher.

## 1.0.0 — 2026-10-17

- Initial Cordis/React chat bundle and native WKWebView shell; streaming chat,
  history, PDF/notebook parsing, markdown and MathML.
