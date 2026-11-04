# LayaPilot · Browser Tests for Enterprise Admin Applications

[中文](README.md) · [Workflow guide](skills/laya-pilot/references/workflows.md) · [Architecture](docs/architecture.md) · [Roadmap](ROADMAP.en.md)

Run browser regression tests from Excel, preserving the original steps and expected results, with reports and failure evidence. LayaPilot can also generate new cases after executing and verifying them. It focuses on admin pages with tables, filters, forms, and CRUD operations.

**The AI skill is the recommended way to use LayaPilot.** An AI assistant helps with configuration, login, execution, and report analysis. You can also run the repository's `run.sh` yourself.

Both options require **Node.js 20+ with npm and Python 3.10+ with venv/pip**. API mode needs no GPU or local model weights.

## Option 1: Use the skill (recommended)

### 1. Install the complete skill directory

Copy the entire [skills/laya-pilot/](skills/laya-pilot/) directory into your AI tool's skill installation directory, or install it after extracting a maintainer-provided `laya-pilot-skill.zip`. [SKILL.md](skills/laya-pilot/SKILL.md) is the entry point. Runtime code is included, so the original repository is not required.

Run once from the **installed skill directory**:

```bash
node scripts/setup.mjs
```

Setup installs Playwright, Chromium, and openpyxl, and creates these local files:

| File                | Contents                                                                          |
| ------------------- | --------------------------------------------------------------------------------- |
| `.env.local`        | API URL, model, key, and optional test credentials                                |
| `config.local.json` | Test page URL, optional workbook path, account, and authentication state settings |

### 2. Configure the API and test page

The skill defaults to API mode and the `laya-decision` model. Override the model if your service requires another compatible model. Fill the skill's `.env.local`:

```dotenv
LAYA_API_BASE=https://your-gateway.example/v1
LAYA_API_MODEL=laya-decision
LAYA_API_KEY=your-api-key
```

The API must support this project's candidate-decision JSON protocol; see [setup and API configuration](skills/laya-pilot/references/setup.md).

Set the target page in `config.local.json` in the same directory. For existing cases, you can also set `excel` to the workbook's absolute path:

```json
{
    "url": "https://your-test-app.example/module"
}
```

Check configuration and identify the installed version:

```bash
node scripts/setup.mjs --check
node scripts/run.mjs --version
```

These files belong to the installed skill directory. Startup output shows configuration sources, the API model, and authentication file state; keys are reported only as present or absent. Local inference requires an explicit `--provider local`; see [setup](skills/laya-pilot/references/setup.md).

### 3. Tell the AI what to do

In a tool supporting `$skill-name`, requests can look like this:

```text
Use $laya-pilot to execute every case in /absolute/path/cases.xlsx.
Inspect parsing first, then run headlessly against my configured test URL and provide reports and failure evidence.

Use $laya-pilot to generate read-only cases for https://your-test-app.example/module.
Remember the authenticated session after login so it can be reused next time.

Use $laya-pilot to analyze /absolute/path/run/results.json and explain failed steps and causes.
```

Existing and generated workbooks both use `--excel`; no separate replay mode is needed. Cases are generated only on request, and an existing workbook is not automatically used as a generation template.

Complete the first login manually, or configure `TEST_USER` and `TEST_PASSWORD` in `.env.local` for automatic login. When asked to remember login, the skill configures an `.auth` file and an authenticated-page marker, then validates and reuses the session on later runs. Expired sessions require login again. Keep passwords and keys out of JSON, command lines, and chat examples.

## Option 2: Run repository code with run.sh

Use this option for manual operation or custom development. Run these commands from the **repository root**, with Python 3.10+ available as `python3`:

```bash
git clone https://github.com/anthonyli/laya-pilot.git
cd laya-pilot
npm ci
npx playwright install chromium
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env.local
```

Fill the API settings shown above in the repository root's `.env.local`. The repository CLI retains its local-model default; these examples explicitly select `--provider api`:

```bash
# Inspect an existing workbook without visiting the application
bash run.sh --provider api --excel /absolute/path/cases.xlsx --inspect

# Execute existing or generated cases
bash run.sh --provider api --excel /absolute/path/cases.xlsx \
  --url https://your-test-app.example/module --headless

# Generate read-only cases from a page
bash run.sh --provider api --mode generate \
  --url https://your-test-app.example/module --read-only
```

Add `--allow-write` only after establishing the test environment and authorization for write operations. See the [workflow guide](skills/laya-pilot/references/workflows.md) for CRUD generation scopes. `run.sh` requires Bash on macOS/Linux; Windows can use `node runner.mjs`. Local model setup and further options are in the [repository runtime guide](docs/local-runtime.md). Use `bash run.sh --help` for command help.

## Outputs and coverage

- Generated workbooks go to `generated-cases/`; reports and evidence go to `runs/`. Skill runs use `runs/laya-pilot/<run>/`.
- Reports include JSON, Markdown, and available browser evidence. Ordinary Excel execution also produces CSV; generation and structured execution produce a separate `执行结果.xlsx`. Input workbooks remain unchanged.
- Generated case files contain only cases that were executed and passed page assertions. Reports retain all attempts and coverage gaps. Fixed-rule checks may make no model calls; reports show the actual API call count.

The current implementation uses Playwright and the Laya decision protocol. Complex approvals, multi-account permissions, file imports, and Canvas need adapters. Read-only filter checks verify control visibility, not the correctness of query results or reset behavior.

## Demo, upgrades, and development

Run `npm run demo`, then test `http://127.0.0.1:8765/customers`. The demo page and existing cases are in [examples/](examples/).

![Public demo](docs/demo.png)

[Introduction video](https://github.com/user-attachments/assets/940b2562-41ff-47ed-a6e0-e179d4d0847d) · [YouTube](https://www.youtube.com/watch?v=aIZEEcTGM0w)

Maintainers can package, check, or explicitly upgrade a chosen installation from the repository root:

```bash
npm run skill:package
npm run skill:check
npm run skill:package -- --install-to /absolute/path/installed-skill
```

The upgrade command preserves `.env.local`, `config.local.json`, `.auth`, dependencies, and models. Deleting the old skill directory also deletes that local data, so a fresh installation requires configuration again. The distribution's `manifest.json` records its version and content digest; local configuration and authentication state are excluded.

For development, run `npm test` and `npm run format:check`. Python and browser test commands are in the [runtime guide](docs/local-runtime.md).

MIT License. Laya, Playwright, and model weights have their own licenses.
