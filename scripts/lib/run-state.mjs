import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function writePrivateJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
            mode: 0o600,
            flag: 'wx',
        });
        fs.renameSync(temporary, file);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

export function resultExitCode(results) {
    if (!results?.length) return 1;
    const passed = results.some((r) => ['通过', '已验证'].includes(r.status));
    return passed && results.every((r) => ['通过', '已验证', '不适用', '未选择'].includes(r.status))
        ? 0
        : 1;
}

// A synchronous, atomic checkpoint is written before a mutating click and after each
// recorded step. A killed process never leaves a half-written checkpoint JSON.
export class RunJournal {
    constructor(out, metadata) {
        this.out = out;
        this.started = performance.now();
        this.results = [];
        fs.mkdirSync(out, { recursive: true, mode: 0o700 });
        this.lock = path.join(out, '.run.lock');
        const fd = fs.openSync(this.lock, 'wx', 0o600);
        fs.closeSync(fd);
        if (
            ['checkpoint.json', 'results.json'].some((name) => fs.existsSync(path.join(out, name)))
        ) {
            fs.unlinkSync(this.lock);
            throw Error('输出目录已有运行记录，请为 --out 指定新的目录');
        }
        this.state = {
            schemaVersion: 1,
            ...metadata,
            startedAt: new Date().toISOString(),
            status: 'running',
            activeCase: null,
            pendingWrite: null,
            results: this.results,
        };
        try {
            this.checkpoint();
        } catch (error) {
            this.close();
            throw error;
        }
    }
    checkpoint(update = {}) {
        Object.assign(this.state, update, { updatedAt: new Date().toISOString() });
        writePrivateJson(path.join(this.out, 'checkpoint.json'), this.state);
    }
    event(type, details = {}) {
        fs.appendFileSync(
            path.join(this.out, 'progress.ndjson'),
            JSON.stringify({ at: new Date().toISOString(), type, ...details }) + '\n',
            { mode: 0o600 },
        );
    }
    completeCase(result, runtime) {
        this.results.push(structuredClone(result));
        this.event('case-completed', { id: result.id, status: result.status });
        // Keep uncertain write information for operator reconciliation.
        this.checkpoint({ activeCase: null, runtime });
    }
    finish(summary, status) {
        const result = {
            ...summary,
            runStatus: status,
            durationMs: Math.round(performance.now() - this.started),
        };
        writePrivateJson(path.join(this.out, 'results.json'), result);
        this.checkpoint({ status, finishedAt: new Date().toISOString() });
        return result;
    }
    close() {
        if (this.lock) {
            fs.unlinkSync(this.lock);
            this.lock = null;
        }
    }
}

export function watchInterruption(stop) {
    const controller = new AbortController();
    let stopping;
    const listeners = new Map();
    for (const signal of ['SIGINT', 'SIGTERM']) {
        const handler = () => {
            if (controller.signal.aborted) return;
            const error = Error(`运行被 ${signal} 中断；进度已保留，请核对未确认的写操作`);
            error.exitCode = signal === 'SIGINT' ? 130 : 143;
            controller.abort(error);
            stopping = Promise.resolve()
                .then(() => stop(error))
                .catch(() => {});
        };
        listeners.set(signal, handler);
        process.on(signal, handler);
    }
    return {
        signal: controller.signal,
        async dispose() {
            for (const [signal, handler] of listeners) process.off(signal, handler);
            await stopping;
        },
    };
}
