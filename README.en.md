# LayaPilot · Browser Tests for Enterprise Admin Applications

[中文](README.md) · [Changelog](references/changelog.md) · [Download skill](https://github.com/anthonyli/laya-pilot/releases/latest) · [Workflow](docs/workflow.en.md) · [Workflow guide](references/workflows.md) · [Setup](references/setup.md) · [Reading reports](references/reports.md) · [Architecture](docs/architecture.md) · [Issues](https://github.com/anthonyli/laya-pilot/issues)

LayaPilot runs test cases in a browser and produces reports with failure evidence. It targets the tables, filters, forms and CRUD pages of enterprise admin applications.

![Public demo](docs/demo.png)

## What it does

| Feature                    | Input                               | Output                                                   |
| -------------------------- | ----------------------------------- | -------------------------------------------------------- |
| **Regress existing Excel** | Your Excel cases + a page URL       | Per-case results, failed steps, screenshots and traces   |
| **Record new cases**       | A page URL; you act in the browser  | An editable Excel case + the original Playwright script  |
| **Generate from a page**   | A page URL + the allowed operations | New Excel cases that were executed and passed assertions |

During execution, the Laya decision model picks controls on the current page. The model is called through an **API** by default; the local model must be enabled explicitly. See the [workflow diagram](docs/workflow.en.md) for how the features fit together.

## Choose how to use it

There are two ways to use LayaPilot. **They are installed separately and do not share configuration.** Pick one:

|               | `laya` command                | AI skill                                                                     |
| ------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| Best for      | Running cases yourself, CI    | Giving natural-language tasks in Cursor, Codex and similar tools             |
| Install       | `npm link`, then `laya setup` | Place it in the AI tool's skill directory, then run `node scripts/setup.mjs` |
| Configuration | `~/.laya/.env.local`          | `.env.local` in the skill directory                                          |
| Commands      | `laya run …`                  | `node scripts/run.mjs …` (usually called by the AI)                          |

The options are identical: `laya X` corresponds to `node scripts/run.mjs X`, and `laya setup` to `node scripts/setup.mjs`.

**Requirements:** Node.js 20+ with npm. Excel features also need Python 3.10+ with venv and pip. Recording and replaying Playwright scripts only does not need Python.

## Command-line quick start

### 1. Install

```bash
git clone https://github.com/anthonyli/laya-pilot.git
cd laya-pilot
npm install
npm link            # use sudo npm link if you lack permission
laya setup          # installs Chromium, a Python venv and openpyxl, and creates the config file
```

Configuration, the Python environment and models live in `~/.laya/` and survive reinstalling `laya`. Set `LAYA_HOME` to use another directory.

### 2. Configure the API

Edit `~/.laya/.env.local`:

```dotenv
LAYA_API_BASE=https://your-gateway.example/v1
LAYA_API_MODEL=laya-decision
LAYA_API_KEY=your-api-key
```

The endpoint must be HTTPS Chat Completions compatible and return the decision JSON this project expects; see the [API protocol](references/setup.md#api-协议). For automatic sign-in, add:

| Setting                              | Purpose                                               |
| ------------------------------------ | ----------------------------------------------------- |
| `TEST_USER`, `TEST_PASSWORD`         | Sign-in account and password                          |
| `TEST_AUTH_STATE`, `TEST_AUTH_CHECK` | Reusable login state file and a signed-in page marker |

Pass the workbook path, page URL and output directory on each run instead of storing them. Never put keys or passwords on the command line.

### 3. Check and run

```bash
laya check                                   # check dependencies and settings (does not contact the gateway)
laya run --excel cases.xlsx --inspect        # check the workbook only, no browser
laya run --excel cases.xlsx --url 'https://your-test-app.example/module' --headless
```

Reports are written to `runs/laya-pilot/<run>/` in the current directory. All commands: `laya --help`.

## Common tasks

### Regress an existing workbook

```bash
laya run --excel cases.xlsx --url 'https://your-test-app.example/module' --headless
```

- Existing workbooks need no conversion. Without cases, copy the [Excel template](assets/test-cases-template.xlsx) and edit its examples following the [template guide](references/case-template.md).
- All cases run by default. Steps and expectations are kept as written, and the input workbook is never modified.
- Cases that create, edit or delete data need `--allow-write` in a test environment.

### Record actions as a case

```bash
laya record 'https://your-test-app.example/customers' --out recorded-cases/filter.spec.cjs
```

1. Perform the workflow in the browser that opens, and use the toolbar's assertion buttons to mark what should appear.
2. Closing the browser saves both `filter.xlsx` (an editable natural-language case) and `filter.spec.cjs` (the original Playwright script).
3. Replay the Excel case:

```bash
laya replay recorded-cases/filter.xlsx --url 'https://your-test-app.example/customers' --headless
```

For Playwright scripts only, without Excel or a model:

```bash
laya setup --recording                       # install the browser only
laya record 'https://your-test-app.example/customers' --code-only --out recorded-cases/filter.spec.cjs
laya replay recorded-cases/filter.spec.cjs --out runs/filter-check
laya report runs/filter-check                # open the HTML report
```

Recordings keep the values you type, so use test data. Convert an earlier recording with `laya export-excel FILE.spec.cjs`. See [Recording and replay](references/recording.md).

### Generate cases from a page

```bash
laya run --mode generate --url 'https://your-test-app.example/module' --read-only
```

LayaPilot explores and executes the page, and exports only cases whose assertions passed, under `generated-cases/`. To review cases before execution, use the [review plan workflow](references/review-plan.md).

### Use a local model

```bash
laya setup --local-model                     # installs dependencies and downloads weights; needs extra disk and memory
laya run --provider local --excel cases.xlsx --url URL --headless
```

Pass `--provider local` on every run. Without it the API is always used; installing weights does not switch the default. See [local model setup](references/setup.md#仅在用户明确要求时本地模型).

## Use as an AI skill

1. Place the whole repository, or the `laya-pilot/` directory from the [Release ZIP](https://github.com/anthonyli/laya-pilot/releases/latest), in your AI tool's skill directory.
2. Run `node scripts/setup.mjs` there, then fill in the API settings (same fields as above) in `.env.local` in that directory.

The `laya` command is not needed. Then give tasks in natural language:

```text
Use $laya-pilot to run every case in /absolute/path/cases.xlsx against https://your-test-app.example/module.
Inspect the parse result first, then run headless and give me the report and failure evidence.

Use $laya-pilot to generate read-only test cases for https://your-test-app.example/module.

Use $laya-pilot to analyze /absolute/path/run/results.json and explain the failed steps.
```

- Given only a URL, the AI first asks whether to generate cases or run an existing workbook.
- Say "remember the login" and the AI saves the login state, then reuses it next time after verifying it.
- Analyzing an existing report needs no dependencies or API settings.

## Reports

Each run creates `runs/laya-pilot/<date_time>/` in the current directory. Share the whole directory:

```text
index.html     start here: reliability verdict, cases, a screenshot for every step
summary.md     text report        results.json   machine-readable   results.xlsx   results table
cases/         one directory per case with a screenshot for every step, e.g. 03-预期2-失败.png
               (third capture, expectation 2, failed); cases that did not pass also keep trace.zip
logs/          process files for troubleshooting
```

Open it with `laya report runs/laya-pilot/<date_time>`. The top of the page gives the verdict: **passed with complete evidence**, **passed but needs review** or **failed**, with the reasons, such as blocked cases, unverified expectations, page or API errors, or missing screenshots. A pass count alone does not tell you whether the result can be trusted; read the verdict.

- Generated cases go to `generated-cases/` and include only cases that executed and passed assertions.
- A passing `--inspect` only means the workbook is valid; page assertions decide whether a test passes.
- Use `--out` for the report directory and `--case-file` for the generated workbook.

See [reading reports](references/reports.md) (Chinese).

## Scope

Coverage today focuses on admin tables, filters, forms and CRUD. Complex approvals, multi-account permissions, file imports and Canvas need dedicated support, tracked in [Issues](https://github.com/anthonyli/laya-pilot/issues).

## Try the demo

```bash
npm run demo        # then open http://127.0.0.1:8765/customers
```

The demo page and cases are in [examples/](examples/); try `examples/demo-cases.xlsx` with the URL above. [Intro video](https://github.com/user-attachments/assets/940b2562-41ff-47ed-a6e0-e179d4d0847d) · [YouTube](https://www.youtube.com/watch?v=aIZEEcTGM0w)

## Development

```text
bin/           laya command entry
scripts/       execution code (shared by the skill and the CLI), setup and packaging
SKILL.md       AI skill entry
references/    skill usage guides
assets/        config template and Excel case template
examples/      demo page and sample cases
docs/          architecture and technical notes
tests/         automated tests
```

```bash
npm ci
npm test && npm run test:browser && npm run format:check   # format check needs uv
```

Package the skill (creates `dist/laya-pilot-skill.zip`, without demo, tests, README or local configuration):

```bash
npm run skill:package
npm run skill:check                                          # compare the ZIP with the sources
python3 scripts/package_skill.py --install-to /path/to/installed-skill   # upgrade an installed copy, keeping its config and login state
```

See the [runtime guide](docs/local-runtime.md) for more verification options.

[MIT License](LICENSE). Laya, Playwright and model weights follow their own licenses.
