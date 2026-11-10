// Track actual request completion; a fixed sleep cannot make reload safe.
export class PendingWrites {
    constructor(page) {
        this.pending = new Map();
        this.sequence = 0;
        this.completed = [];
        page.on('request', (request) => {
            if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) return;
            let done;
            const promise = new Promise((resolve) => {
                done = resolve;
            });
            this.pending.set(request, { promise, done, sequence: ++this.sequence, status: null });
        });
        page.on('response', (response) => {
            const entry = this.pending.get(response.request());
            if (entry) entry.status = response.status();
        });
        const finish = (request, failed = false) => {
            const entry = this.pending.get(request);
            if (entry) {
                this.completed.push({ sequence: entry.sequence, status: entry.status, failed });
                if (this.completed.length > 100) this.completed.shift();
                entry.done();
                this.pending.delete(request);
            }
        };
        page.on('requestfinished', (request) => finish(request));
        page.on('requestfailed', (request) => finish(request, true));
    }
    async wait(timeout = 8000) {
        let timer;
        try {
            await Promise.race([
                (async () => {
                    while (this.pending.size)
                        await Promise.all([...this.pending.values()].map((entry) => entry.promise));
                })(),
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () => reject(Error('写请求尚未完成，拒绝刷新页面')),
                        timeout,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }
}
