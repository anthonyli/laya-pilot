# LayaPilot · Intelligent Browser Test Automation

[中文](README.md) · [Architecture and extension points](docs/architecture.md) · [Roadmap](ROADMAP.en.md)

Generate **replayable Excel test cases from a live browser page**, or execute an existing natural-language Excel workbook. The current implementation uses Playwright for browser control and either local Laya or a compatible decision API to resolve ambiguous controls. Assertions inspect the resulting page; a model choice alone never counts as a passing test.

This public project includes a local demo, without company-specific adapters, internal URLs, accounts, or gateway settings. **Only the Playwright browser driver and the Laya decision protocol are implemented today.** browser-use and Jev API are listed in the [Roadmap](ROADMAP.en.md), not available backends yet.

![Customer management page in the public demo](docs/demo.png)

## Introduction video

https://github.com/user-attachments/assets/940b2562-41ff-47ed-a6e0-e179d4d0847d

[Watch on YouTube](https://www.youtube.com/watch?v=aIZEEcTGM0w)

## Features

| Entry point | What it does | Outputs |
| --- | --- | --- |
| `--mode generate` | Explores tabs, tables, filters, form validation, and supported CRUD actions | 17-column XLSX, report, browser evidence |
| `--mode execute` | Re-discovers DOM controls and replays a generated workbook | Separate `执行结果.xlsx`, report, evidence |
| `--excel` | Executes supported steps from an existing workbook; selects source rows marked `pass` by default | JSON, CSV and Markdown reports |

Only flows that completed with a page assertion are written to a generated workbook. The visible steps and expected results follow the 17-column template; a hidden sheet holds structured replay steps. If the visible case changes without its replay steps, execution stops. Failures capture the failed step, page and console errors, HTTP 4xx/5xx events, and screenshots. Approval, multi-user permissions, file import, and arbitrary websites or prose cases are not universally supported.

## Requirements and local Laya

- Node.js **20+**, Python **3.10+** (3.11 or 3.12 recommended), and Playwright Chromium. Use `node runner.mjs` on macOS, Linux or Windows; `run.sh` is a macOS/Linux convenience script.
- **We recommend installing official Laya locally** with the [`convaiinnovations/laya-multilingual`](https://huggingface.co/convaiinnovations/laya-multilingual) checkpoint for both Chinese and English pages. The first run downloads model files. Later runs can use the cache or a directory supplied through `LAYA_MODEL`. Do not commit weights.
- **Practical recommendation, not an official minimum:** at least 4 CPU cores, **16 GB RAM**, and **5 GB free disk space** for local model + browser use; a discrete GPU is not required. We verified CPU operation on an Apple Silicon M4 with 16 GB RAM: the local model directory was about 647 MB and one initial load took about 27 seconds. Your machine may differ. API mode does not load Laya locally but still needs Node, a browser, Python, and `openpyxl`.

```bash
git clone <your-repository-url> laya-pilot
cd laya-pilot
npm install
npx playwright install chromium
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements-local.txt
```

On Windows, pass `.venv\Scripts\python.exe` with `--python`. For API-only use, install `requirements.txt` instead of `requirements-local.txt`. Consult the [official model card](https://huggingface.co/convaiinnovations/laya-multilingual) and [official Python project](https://github.com/NandhaKishorM/laya) for current Laya installation guidance.

## Try the demo

Start the demo in one terminal and run cases in another. Customer data lives in browser localStorage, and some DOM IDs change on every visit.

```bash
npm run demo
./run.sh --mode generate --url http://127.0.0.1:8765/customers \
  --case-file generated-cases/customers.xlsx
./run.sh --mode execute --case-file generated-cases/customers.xlsx \
  --url http://127.0.0.1:8765/customers
```

The browser is visible by default; add `--headless` when ready. To try an existing workbook, use `./run.sh --excel examples/demo-cases.xlsx --url http://127.0.0.1:8765/customers`. Generation performs real create, edit and delete operations, so use a dedicated test environment.

## Configure your system

Copy [`config.example.json`](config.example.json) to `config.local.json` and set your test URL and runtime options. Copy [`.env.example`](.env.example) to `.env.local` for local passwords and API keys. Both local files are ignored by Git. The launcher reads `.env.local` without executing shell code. CLI arguments override shell variables, which override `.env.local`, which overrides the JSON file. Passwords and API keys are accepted **only through environment variables, `.env.local`, or a hidden terminal prompt**, never through the JSON config.

```bash
./run.sh --mode generate --config config.local.json --manual-login
./run.sh --mode execute --config config.local.json \
  --case-file generated-cases/customers.xlsx
```

For automatic login, pass `--user` or `TEST_USER`; supply the password through `TEST_PASSWORD` (optionally in `.env.local`) or the hidden prompt. API mode requires `LAYA_API_BASE`, `LAYA_API_MODEL`, and `LAYA_API_KEY`:

```bash
export LAYA_API_BASE='https://your-gateway.example/v1'
export LAYA_API_MODEL='your-decision-model'
export LAYA_API_KEY='your-secret-key'
./run.sh --mode generate --provider api --url 'https://your-test-app.example/module' --manual-login
```

Local mode defaults to `convaiinnovations/laya-multilingual`; set `LAYA_MODEL=/path/to/model` and `LAYA_PYTHON=/path/to/python` to override it. The browser defaults to Playwright's bundled Chromium; `--browser-channel chrome` uses a separately installed Chrome. `--browser-provider` currently accepts only `playwright` and rejects unsupported values. `--template-excel` can supply a matching 17-column workbook; otherwise the tool creates one without relying on a personal file.

Run artifacts go to ignored `runs/` and generated workbooks to ignored `generated-cases/`. Reports and workbooks may contain test URLs, page text or test data; review them before sharing. Run `./run.sh --help` for CLI options.

## Development and limitations

```bash
npm test
```

Control discovery uses DOM, labels, ARIA roles and some common component classes. It re-observes dynamic DOM, but Canvas controls, closed Shadow DOM, unlabeled custom widgets, and cross-account workflows need adapters. See the [architecture guide](docs/architecture.md) for extension points and current boundaries.

MIT License. Laya, Playwright and model weights have their own licenses.
