# LayaPilot workflow

[中文](workflow.md) · [Back to README](../README.en.md)

## Overview

```mermaid
flowchart TD
    skill["AI skill<br/>node scripts/run.mjs<br/>config: skill directory/.env.local"]
    cli["laya command<br/>bin/laya.mjs<br/>config: ~/.laya/.env.local"]
    skill --> entry
    cli --> entry
    entry["lib/entry.mjs + common.mjs<br/>choose config directory and command spelling<br/>precedence: CLI > environment > .env.local > defaults"]
    entry --> dispatch{"run.mjs<br/>dispatch by subcommand"}

    dispatch -->|"setup / check"| setup["setup.mjs<br/>Python venv + openpyxl<br/>Chromium · local model (on request)"]
    dispatch -->|"record / replay / report / export-excel"| rec["Recording<br/>lib/recording.mjs"]
    dispatch -->|"--mode plan"| plan["review-plan.mjs<br/>offline draft, no page access"]
    dispatch -->|"--mode reviewed"| reviewed["runner.mjs<br/>verify --approved-hash"]
    dispatch -->|"--excel / --mode generate"| runner["runner.mjs<br/>detect workbook format"]

    plan --> draft["Draft plan + SHA-256"]
    draft -->|"user approves"| reviewed
    reviewed --> workflow

    runner -->|"ordinary cases (six-column template)"| worker["worker.py<br/>read and validate Excel"]
    runner -->|"structured plan / generate"| workflow["lib/workflow.mjs<br/>discovery · write policy · replay and assertions"]
    worker --> engine["lib/engine.mjs<br/>step execution + Laya model decisions<br/>(API by default, local needs --provider local)"]

    rec --> codegen["record URL<br/>Playwright Codegen: actions + marked assertions"]
    codegen --> spec["FILE.spec.cjs<br/>original Playwright test"]
    codegen --> xlsx["FILE.xlsx<br/>natural-language case, six-column template"]
    xlsx -->|"replay FILE.xlsx = --excel"| runner
    spec -->|"replay FILE.spec.cjs"| pwtest["Playwright Test<br/>HTML report + results.json"]

    engine --> out
    workflow --> out
    pwtest --> out
    out[("Output: current directory/runs/laya-pilot/date_time/<br/>index.html · summary.md · results.json/xlsx<br/>cases/ per-step screenshots and failed-case traces · logs/<br/>input workbook is never modified")]
```

## Stages

| Stage            | Entry                                     | What it does                                                                    |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| Setup and check  | `laya setup` / `laya check`               | Install Python venv, openpyxl and Chromium; check dependencies and API settings |
| Inspect cases    | `laya run --excel FILE --inspect`         | Parse and diagnose the workbook without a browser or model                      |
| Excel regression | `laya run --excel FILE --url URL`         | Ordinary cases: `worker.py` then Engine; structured plans: workflow             |
| Generate cases   | `laya run --mode generate --url URL`      | Explore and execute the page; export only cases whose assertions passed         |
| Review first     | `--mode plan` → `--mode reviewed`         | Draft offline with a digest; execute only after that digest is approved         |
| Record           | `laya record URL`                         | Act in the browser and mark assertions; saves Excel and the Playwright script   |
| Replay           | `laya replay FILE.xlsx` / `FILE.spec.cjs` | Excel goes to the Laya runner; `.spec.cjs` goes to Playwright Test              |

In the skill, replace `laya X` with `node scripts/run.mjs X` and `laya setup` with `node scripts/setup.mjs`.

## Rules

- **Two entries, one execution layer.** The skill and the CLI differ only in config directory and command spelling, and never read each other's configuration.
- **`--excel` routes automatically.** An invalid structured plan is an error; it never falls back to ordinary parsing.
- **Writes need authorization.** Create, edit and delete require an explicit `--allow-write`, including recorded replays.
- **API model by default.** The local model is used only when a run passes `--provider local`.
- **Output goes to the current directory.** Reports in `runs/laya-pilot/<date_time>/`; start with `index.html` (see [reading reports](../references/reports.md)), recordings in `recorded-cases/`, generated cases in `generated-cases/`, all relative to where the command runs.
