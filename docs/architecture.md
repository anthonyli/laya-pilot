# Architecture / 架构

The public runner has three paths: `generate` and `execute` in `lib/workflow.mjs`, and natural-language workbook execution in `lib/engine.mjs`. `worker.py` imports spreadsheets through `openpyxl` and performs local Laya decisions when requested. API decisions use `lib/model.mjs`; the API key remains in the environment or a hidden prompt. Browser initialization is centralized in `lib/browser-provider.mjs`.

The browser session currently exposes a Playwright `browser`, `context`, and `page`. A new browser backend must implement the page operations used by `lib/dom.mjs`, `lib/form.mjs`, `lib/readiness.mjs`, `lib/workflow.mjs`, and `lib/engine.mjs`, plus context tracing and diagnostic events. Merely accepting `--browser-provider browser-use` would be misleading; the runner rejects it until an adapter and integration tests exist.

The decision boundary is `choose(state, criteria, meta)`, returning a choice among the supplied candidates and calibrated probabilities or an explicit failure. Local Laya and the currently compatible HTTP API implement this behavior. A future Jev API adapter needs an explicit request/response mapping, probability validation, credential handling and contract tests before it can be selected.

The workbook contract is in `lib/workflow_excel.py`. The visible 17 columns are human readable; `__laya_steps__` contains a structured, validated replay plan. The digest binds the visible case ID, title, preconditions, steps and expected result to the plan. The generated Excel is a test artifact, not arbitrary executable code.

Current UI coverage is strongest for semantic HTML plus Ant Design, Element and TNTD conventions. A new component family should extend observation and form rules, then add a browser fixture test. Keep company-specific selectors, URLs, credentials and data preparation in a separate private adapter repository rather than this public core.
