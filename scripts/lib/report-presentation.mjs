// Embedded in the report so it can be opened directly from a copied run directory.
// The paper, ink, typography, card and status tokens follow software-compare.
export const reportStyles = `
:root {
    color-scheme: light;
    --paper: #f3f4f6;
    --ink: #111111;
    --text: #3a3a3a;
    --muted: #5c5c5c;
    --line: #e6e6ea;
    --ok: #0f7b4a;
    --warn: #a0560c;
    --bad: #ac2938;
    --shadow: 0 1px 2px rgba(17,17,17,.04), 0 8px 24px rgba(17,17,17,.05);
    --card: 1.25rem;
    font: 15px/1.6 "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
    color: var(--ink);
    background: var(--paper);
}
* { box-sizing: border-box; }
body {
    margin: 0;
    background-image: linear-gradient(#11111109 1px, transparent 1px), linear-gradient(90deg,#11111109 1px, transparent 1px);
    background-size: 48px 48px;
    overflow-wrap: anywhere;
}
::selection { background: var(--ink); color: white; }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
button { font: inherit; color: inherit; cursor: pointer; }
a { color: var(--ink); text-underline-offset: .2em; }
small, .meta, .files { color: var(--muted); font-size: .86rem; }
main, .brand-row { width: min(1120px, calc(100% - 64px)); margin-inline: auto; }
.masthead { background: white; border-bottom: 1px solid var(--line); }
.brand-row { min-height: 56px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.brand { display: flex; align-items: center; gap: 9px; font: 800 1.18rem/1 system-ui,sans-serif; letter-spacing: -.035em; }
.brand svg { background: var(--ink); color: white; padding: 5px; border-radius: 8px; }
main { padding: clamp(24px,4vw,52px) 0 64px; }
h1, h2, h3, p, ul, ol { margin: 0; }
h1 { font-size: clamp(2rem, 4vw, 3rem); line-height: 1.2; letter-spacing: -.035em; }
h2 { font-size: 1.4rem; letter-spacing: -.02em; }
h3 { font-size: 1rem; }
.meta { margin: 10px 0 22px; }
.overview, .case, .resources, .run-evidence { background: white; border-radius: var(--card); box-shadow: var(--shadow); }
.overview { overflow: hidden; }
.verdict { padding: 20px 26px; display: grid; grid-template-columns: minmax(140px,1fr) 3fr; gap: 20px; }
.bad, .fail { --tone: var(--bad); --tint: #fcecef; }
.warn, .flaky, .unverified, .blocked { --tone: var(--warn); --tint: #fff3e0; }
.ok, .pass { --tone: var(--ok); --tint: #e5f6ee; }
.info, .neutral { --tone: var(--muted); --tint: var(--paper); }
.verdict h2 { width: fit-content; height: fit-content; color: var(--tone); font-size: 1.65rem; }
.signals, .issues { padding-left: 1.2em; font-size: .93rem; color: var(--text); }
.signals li + li, .issues li + li { margin-top: 3px; }
.signals li::marker, .issues li::marker { color: var(--tone); }
.stats { display: flex; flex-wrap: wrap; border-top: 1px solid var(--line); padding: 15px 0; }
.stat { flex: 1 1 100px; padding-inline: 24px; }
.stat + .stat { border-inline-start: 1px solid var(--line); }
.stat b { display: block; font: 650 1.65rem/1.2 system-ui,sans-serif; font-variant-numeric: tabular-nums; color: var(--tone,var(--ink)); }
.stat span { color: var(--muted); font-size: .82rem; }
.section-title { margin: 30px 0 12px; }
.case { margin: 10px 0; }
summary { cursor: pointer; }
.case > summary { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 17px 24px; list-style: none; }
.case > summary::-webkit-details-marker { display: none; }
.case > summary::after { content: ''; width: 8px; height: 8px; border: solid var(--muted); border-width: 0 1.5px 1.5px 0; transform: rotate(45deg); margin-left: 6px; }
.case[open] > summary::after { transform: rotate(225deg); }
.case > summary small { margin-left: auto; }
.case-title { font-size: 1.1rem; font-weight: 650; }
.case-id { font-size: .85rem; color: var(--muted); }
.badge { color: var(--tone); background: var(--tint); padding: 2px 9px; border-radius: 999px; font-size: .8rem; font-weight: 650; white-space: nowrap; }
.case-body { margin: 0 24px; border-top: 1px solid var(--line); padding: 16px 0 22px; }
.case-body > * + * { margin-top: 16px; }
.reason { white-space: pre-wrap; color: var(--text); }
.note { color: var(--warn); }
.diagnostics { background: var(--paper); border-radius: 9px; padding: 8px 14px; font-size: .9rem; }
.diagnostics > summary { font-weight: 600; }
.issues { padding-block: 10px 4px; }
.timeline { list-style: none; padding: 0; }
.timeline li { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; padding: 14px 0; border-top: 1px solid var(--line); }
.step { min-width: 0; }
.step b { margin-inline: 4px; }
.step small { display: block; margin-top: 5px; font-variant-numeric: tabular-nums; }
.shot { position: relative; display: block; padding: 0; max-width: 100%; background: var(--paper); border: 1px solid #d4d4d8; border-radius: 9px; overflow: hidden; cursor: zoom-in; }
.shot img { display: block; width: 100%; height: auto; max-height: 200px; object-fit: contain; }
.timeline .shot { flex: 0 0 min(31%,260px); }
.final .shot { margin-top: 8px; width: min(340px,100%); }
.shot-icon { position: absolute; right: 6px; bottom: 6px; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: #111d; color: white; }
.shot:hover { border-color: var(--ink); }
.run-evidence, .resources { padding: 18px 24px; }
.run-evidence { margin-top: 16px; }
.file-list { list-style: none; padding: 0; }
.file-list li { display: grid; grid-template-columns: minmax(100px,200px) 1fr; gap: 16px; padding: 8px 0; font-size: .9rem; color: var(--muted); }
.file-list li + li { border-top: 1px solid var(--line); }
.resources p { margin-top: 12px; }
.image-link { border: 0; background: transparent; padding: 0; text-decoration: underline; text-underline-offset: .2em; }
html:has(.viewer[open]) { overflow: hidden; }
.viewer { width: fit-content; max-width: calc(100vw - 32px); max-height: calc(100dvh - 32px); margin: auto; padding: 0; border: 0; border-radius: 12px; background: white; color: var(--ink); box-shadow: 0 16px 60px #0004; }
.viewer::backdrop { background: rgba(17,17,17,.82); }
.viewer header { display: flex; justify-content: space-between; gap: 24px; align-items: center; padding: 8px 12px 8px 16px; }
.viewer-title { font-size: .94rem; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.viewer button { flex: none; display: grid; place-items: center; width: 40px; height: 40px; background: var(--paper); border: 0; border-radius: 50%; }
.viewer button:hover { background: #e8eaee; }
.viewer img { display: block; margin-inline: auto; max-width: 100%; max-height: calc(100dvh - 90px); object-fit: contain; }
@media (max-width: 680px) {
    main, .brand-row { width: calc(100% - 28px); }
    .brand-row small { font-size: .73rem; }
    .verdict { grid-template-columns: 1fr; gap: 8px; padding: 16px; }
    .stats { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); row-gap: 14px; }
    .stat { padding-inline: 14px; }
    .stat:nth-child(3n+1) { border-inline-start: none; }
    .case > summary, .resources, .run-evidence { padding: 14px 16px; }
    .case > summary small { order: 1; width: 100%; }
    .case > summary::after { margin-left: auto; }
    .case-body { margin-inline: 16px; }
    .timeline li { display: block; }
    .timeline .shot { margin-top: 10px; width: min(300px,100%); }
    .file-list li { grid-template-columns: 1fr; gap: 0; }
    .viewer { max-width: calc(100vw - 12px); }
}
`;

// Only this function's source is embedded. It must have no module dependencies.
export function setupScreenshotViewer() {
    const dialog = document.querySelector('.viewer');
    const image = dialog.querySelector('img');
    const title = dialog.querySelector('.viewer-title');
    const close = dialog.querySelector('button');
    let trigger;

    document.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-shot]');
        if (!button) return;
        trigger = button;
        title.textContent = button.dataset.caption;
        image.alt = button.dataset.caption;
        image.src = button.dataset.shot;
        dialog.showModal();
    });
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const box = dialog.getBoundingClientRect();
        if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
        )
            dialog.close();
    });
    dialog.addEventListener('close', () => {
        image.removeAttribute('src');
        trigger?.focus({ preventScroll: true });
    });
}
