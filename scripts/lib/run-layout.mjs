import fs from 'node:fs';
import path from 'node:path';

// One layout for every run directory, whichever executor produced it:
//
//   index.html      start here: reliability overview, cases, screenshots
//   summary.md      text report for reading or for an AI assistant
//   results.json    machine-readable results
//   results.xlsx    one row per case (Excel runs)
//   cases/NNN-ID-TITLE/   screenshots and details of one case
//   run/            run-level screenshots (startup failure, page discovery)
//   trace/trace.zip Playwright trace of the whole run
//   logs/           process files kept for troubleshooting
export const RUN_FILES = {
    index: 'index.html',
    summary: 'summary.md',
    results: 'results.json',
    workbook: 'results.xlsx',
    trace: 'trace/trace.zip',
};

export const projectRunsDirectory = (cwd = process.cwd()) => path.join(cwd, 'runs', 'laya-pilot');
export const LATEST_RUN = 'latest.json';

/** Relative path of a process file under logs/. */
export const logPath = (name) => `logs/${name}`;

/** Absolute path of a process file, creating logs/ on demand. */
export function logFile(out, name) {
    fs.mkdirSync(path.join(out, 'logs'), { recursive: true });
    return path.join(out, logPath(name));
}

/** Readable, file-system-safe name fragment. */
export function slug(value, max = 40) {
    const text = String(value ?? '')
        .normalize('NFC')
        // Path separators, characters invalid on Windows, controls and whitespace.
        .replace(/[\\/:*?"<>|\p{Cc}\s]+/gu, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .replace(/-+/g, '-');
    return [...text].slice(0, max).join('');
}

/** cases/001-ID-TITLE: ordered, readable and unique within a run. */
export function caseDirectory(sequence, id, title) {
    const order = String(sequence).padStart(3, '0');
    // A numeric id equal to the run order (001, 1) would only repeat the prefix.
    const ownId = /^\d+$/.test(String(id ?? '')) && Number(id) === sequence ? '' : slug(id, 30);
    const parts = [order, ownId, slug(title)].filter(Boolean);
    // Drop the title when it repeats the id.
    if (parts.length === 3 && parts[2] === parts[1]) parts.pop();
    return `cases/${parts.join('-')}`;
}

/** Assigns one directory per case object, in first-seen order. */
export class CaseDirectories {
    constructor() {
        this.directories = new Map();
    }
    for(key, id, title) {
        if (!this.directories.has(key))
            this.directories.set(key, caseDirectory(this.directories.size + 1, id, title));
        return this.directories.get(key);
    }
}

/** Local time run directory name, e.g. 2026-11-20_12-47-26. */
export function runDirectoryName(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/** A new directory under parent; appends _2, _3 … when the second is already taken. */
export function uniqueRunDirectory(parent, date = new Date()) {
    const base = path.join(parent, runDirectoryName(date));
    let candidate = base;
    for (let n = 2; fs.existsSync(candidate); n++) candidate = `${base}_${n}`;
    return candidate;
}
