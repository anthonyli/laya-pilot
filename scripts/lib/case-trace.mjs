import fs from 'node:fs/promises';
import path from 'node:path';
import { outcome } from './run-index.mjs';

const OPTIONS = { screenshots: true, snapshots: true, sources: false };

// One Playwright trace per case. Tracing starts at the beginning of each case and
// stops at its end, so cases never share trace resources and an interrupted case
// can still be saved. Start it only after login: credentials are never recorded.
// Traces of passed cases are discarded, so the run directory only grows for cases
// someone has to investigate.
export class CaseTraces {
    constructor(context, out, { timeout = 5000 } = {}) {
        this.tracing = context.tracing;
        this.out = out;
        this.timeout = timeout;
        this.open = false;
    }

    async bounded(work) {
        let timer;
        try {
            return await Promise.race([
                work,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(Error('保存执行轨迹超时')), this.timeout);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Start recording the next case. */
    async begin() {
        if (this.open) await this.bounded(this.tracing.stop()).catch(() => {});
        await this.tracing.start(OPTIONS);
        this.open = true;
    }

    /**
     * Stop recording the case. Keeps <directory>/trace.zip unless the case passed,
     * did not apply or never ran; records `trace` or `trace_error` on the result.
     */
    async end(result, directory, { force = false } = {}) {
        if (!this.open) return;
        this.open = false;
        const keep =
            Boolean(result && directory) &&
            (force ||
                (!['pass', 'neutral'].includes(outcome(result.status)) &&
                    !String(result.status).startsWith('未执行')));
        if (!keep) return this.bounded(this.tracing.stop()).catch(() => {});
        const relative = `${directory}/trace.zip`;
        try {
            await fs.mkdir(path.join(this.out, directory), { recursive: true });
            await this.bounded(this.tracing.stop({ path: path.join(this.out, relative) }));
            result.trace = relative;
        } catch (error) {
            // A failed save can leave a truncated zip behind; never offer a file that cannot open.
            await fs.rm(path.join(this.out, relative), { force: true }).catch(() => {});
            result.trace_error = `执行轨迹保存失败：${error?.message || error}`;
        }
    }

    /** End of run or interruption: a case still recording keeps its trace. */
    async stop(active = null, directory = null) {
        // A case that has not finished keeps its trace whatever its provisional status.
        await this.end(active, directory, { force: Boolean(active && directory) });
    }
}
