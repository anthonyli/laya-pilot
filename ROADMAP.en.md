# Roadmap

[中文](ROADMAP.md)

Target **enterprise admin applications** and prioritize **accuracy, speed and stability**, using local or intranet inference. Shipped work is separated from future work; no release dates are promised.

| Priority | Work                                     | Status and limits                                                                                                                                              |
| -------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Headless sessions and authentication     | Shipped: cookies/localStorage/IndexedDB, optional sessionStorage, origin/account binding, authenticated marker and expiry handling                             |
| P0       | Progress and failure handling            | Shipped for workflows: atomic checkpoints, write intent, output locks, SIGINT/SIGTERM partial results and failure exit codes; no automatic resume              |
| P0       | Accuracy and regression coverage         | Shipped: exact unique owned-row matching, no blind write resends; real Chromium generation/replay/HTTP 500/interruption/auth tests                             |
| P0       | Model startup                            | Shipped: local preload by default, overlapping browser setup; readiness before tests, explicit lazy mode and startup timings                                   |
| P1       | Generation policy                        | Partial: operation scope, read-only replay checks, field data overrides and optional deletion; advanced data and cross-run cleanup rules remain open           |
| P1       | Frontend components                      | Partial: native/recognized tree and multi-selects, dates, separate account/name fields, fixed-column actions and labelled icons; arbitrary widgets remain open |
| P1       | Business acceptance                      | User-management validation and CRUD generation/replay verified; pagination, permission matrices, other modules and broad stability measurements remain open    |
| P2       | Browser Use experiment / driver contract | Research complete; defer full replacement. Compare with a local/intranet general model and identical assertions before extracting a complete driver contract   |
| P2       | Jev API adapter                          | Deferred pending a concrete contract; existing local / compatible api decision protocols remain supported                                                      |
| P2       | Roles and approvals                      | Not implemented; requires explicit actors, transitions and business assertions                                                                                 |
| P2       | Case editing and migration               | Not implemented; needs reviewable rebinding of edited workbooks                                                                                                |

`--browser-provider` accepts only `playwright`; `--provider` accepts only `local` or `api`. See the [runtime guide](docs/local-runtime.md) and [Browser Use evaluation](docs/browser-use-evaluation.md).
