// The demo is served as plain JavaScript. Its pinned UI libraries are loaded by index.html.
function startWorkspace() {
    const html = window.htm.bind(React.createElement);
    const { useState } = React;
    const { Button, Drawer, Form, Icon, Input, Modal, Select, Table, Tabs, Tooltip, message } =
        antd;
    const base = '/react-demo/';
    const onIndicators = location.pathname === base + 'realtime';
    const storageKey = 'laya-demo-react-indicators-v1';
    const templates = [
        {
            name: 'Event count',
            icon: 'number',
            detail: 'Count events for a field within a time window.',
        },
        {
            name: 'Distinct values',
            icon: 'filter',
            detail: 'Count unique field values within a time window.',
        },
    ];
    const defaults = {
        name: '',
        template: templates[0].name,
        application: '',
        description: '',
        window: '5',
        unit: 'Minute(s)',
        field: '',
        online: false,
    };
    function loadRecords() {
        const saved = localStorage.getItem(storageKey);
        if (saved) return JSON.parse(saved);
        return [
            {
                id: 'login-velocity',
                name: 'Login velocity',
                field: '[Field] Login Account',
                online: true,
                window: '5',
            },
            {
                id: 'device-activity',
                name: 'Device activity',
                field: '[Field] Device ID',
                online: false,
                window: '15',
            },
            {
                id: 'session-attempts',
                name: 'Session attempts',
                field: '[Field] Login Account',
                online: false,
                window: '30',
            },
        ].map((row) => ({ ...defaults, application: 'initApp', ...row }));
    }

    function ActionIcon({ name, icon, onClick }) {
        return html`<${Tooltip} title=${name} placement="top">
            <${Button} type="link" aria-label=${name} onClick=${onClick}
                ><${Icon} type=${icon} aria-hidden="true"
            /><//>
        <//>`;
    }
    function Navigation() {
        const [center, setCenter] = useState(onIndicators);
        return html`<aside className="side">
            <div className="rail">
                <a className="monogram" href=${base} aria-label="Workspace home">L</a>
                <${Tooltip} title="Workspace" placement="right">
                    <button
                        className=${!center ? 'rail-icon current' : 'rail-icon'}
                        aria-label="Workspace"
                        onClick=${() => setCenter(false)}
                    >
                        <${Icon} type="dashboard" aria-hidden="true" />
                    </button>
                <//>
                <${Tooltip} title="Indicator Center" placement="right">
                    <button
                        className=${center ? 'rail-icon current' : 'rail-icon'}
                        aria-label="Indicator Center"
                        aria-expanded=${center}
                        aria-controls="workspace-menu"
                        onClick=${() => setCenter(true)}
                    >
                        <${Icon} type="sliders" aria-hidden="true" />
                    </button>
                <//>
            </div>
            <nav className="menu" id="workspace-menu">
                <strong className="brand">falcon</strong>
                <h2>${center ? 'Indicator Center' : 'Workspace'}</h2>
                ${
                    center
                        ? html`<a
                              href=${base + 'realtime'}
                              aria-current=${onIndicators ? 'page' : undefined}
                              >Realtime Indicator</a
                          >`
                        : html`<a href=${base} aria-current=${onIndicators ? undefined : 'page'}
                              >System overview</a
                          >`
                }
                <a className="other-demo" href="/customers">HTML demo ↗</a>
            </nav>
        </aside>`;
    }
    function Overview({ rows }) {
        const online = rows.filter((row) => row.online).length;
        return html`<main>
            <h1>System overview</h1>
            <p className="intro">
                Open Indicator Center in the left rail to manage realtime indicators.
            </p>
            <section className="surface overview">
                <h2>Configuration status</h2>
                <div className="figures">
                    ${[
                        ['Total configurations', rows.length],
                        ['Draft', rows.length - online],
                        ['Online', online],
                    ].map(
                        ([label, value]) =>
                            html`<div key=${label}>
                                <span>${label}</span><strong>${value}</strong>
                            </div>`,
                    )}
                </div>
                <div className="distribution" aria-hidden="true">
                    <div
                        style=${{ width: (rows.length ? (online / rows.length) * 100 : 0) + '%' }}
                    />
                </div>
            </section>
        </main>`;
    }
    function Dropdown({ id, label, choices, value, onChange }) {
        return html`<${Form.Item} label=${label} htmlFor=${id}>
            <${Select}
                id=${id}
                aria-label=${label}
                placeholder=${'Select ' + label.toLowerCase()}
                value=${value || undefined}
                onChange=${onChange}
            >
                ${choices.map((choice) => html`<${Select.Option} key=${choice} value=${choice}>${choice}<//>`)}
            <//>
        <//>`;
    }
    function ConfigDrawer({ initial, onClose, onSave }) {
        const [values, setValues] = useState(initial || defaults);
        const [selectTemplate, setSelectTemplate] = useState(!initial);
        const [error, setError] = useState('');
        const set = (key) => (value) => {
            setValues((old) => ({ ...old, [key]: value }));
            setError('');
        };
        function submit(event) {
            event.preventDefault();
            if (!values.name.trim() || !values.application || !values.field) {
                setError('Enter a name and select an application and a field.');
                return;
            }
            if (!/^[1-9]\d*$/.test(values.window)) {
                setError('Enter a positive whole number for the time window.');
                return;
            }
            const error = onSave({ ...values, name: values.name.trim() });
            if (error) setError(error);
        }
        const title = selectTemplate
            ? 'Select a template'
            : initial
              ? 'Edit configuration'
              : 'New configuration';
        return html`<${Drawer}
            title=${title}
            visible=${true}
            width="min(480px, 100vw)"
            onClose=${onClose}
        >
            ${
                selectTemplate
                    ? html`<div className="template-list">
                          ${templates.map(
                              (template) =>
                                  html`<button
                                      key=${template.name}
                                      className="template"
                                      aria-label=${template.name}
                                      onClick=${() => {
                                          set('template')(template.name);
                                          setSelectTemplate(false);
                                      }}
                                  >
                                      <${Icon} type=${template.icon} aria-hidden="true" />
                                      <span
                                          ><strong>${template.name}</strong
                                          ><small>${template.detail}</small></span
                                      >
                                      <${Icon} type="right" aria-hidden="true" />
                                  </button>`,
                          )}
                      </div>`
                    : html` <form
                          className="ant-form ant-form-vertical config-form"
                          onSubmit=${submit}
                      >
                          <div className="template-summary">
                              Template <strong>${values.template}</strong>
                          </div>
                          <${Form.Item} label="Name" htmlFor="configuration-name" required>
                              <${Input}
                                  id="configuration-name"
                                  value=${values.name}
                                  onChange=${(e) => set('name')(e.target.value)}
                                  autoComplete="off"
                              />
                          <//>
                          <${Dropdown}
                              label="Application"
                              id="application"
                              value=${values.application}
                              choices=${['initApp', 'webApp']}
                              onChange=${set('application')}
                          />
                          <${Form.Item} label="Description" htmlFor="description">
                              <${Input.TextArea}
                                  id="description"
                                  rows=${2}
                                  value=${values.description}
                                  onChange=${(e) => set('description')(e.target.value)}
                              />
                          <//>
                          <div className="time-fields">
                              <${Form.Item} label="Time window" htmlFor="time-window">
                                  <${Input}
                                      id="time-window"
                                      inputMode="numeric"
                                      value=${values.window}
                                      onChange=${(e) => set('window')(e.target.value)}
                                  />
                              <//>
                              <${Dropdown}
                                  label="Unit"
                                  id="time-unit"
                                  value=${values.unit}
                                  choices=${['Second(s)', 'Minute(s)', 'Hour(s)']}
                                  onChange=${set('unit')}
                              />
                          </div>
                          <${Dropdown}
                              label="Field"
                              id="indicator-field"
                              value=${values.field}
                              choices=${['[Field] Login Account', '[Field] Device ID', '[Field] IP Address']}
                              onChange=${set('field')}
                          />
                          ${error && html`<p className="form-error" role="alert">${error}</p>`}
                          <div className="drawer-actions">
                              <${Button} onClick=${onClose}>Cancel<//
                              ><${Button} type="primary" htmlType="submit">Save<//>
                          </div>
                      </form>`
            }
        <//>`;
    }
    function Indicators({ rows, commit }) {
        const [area, setArea] = useState(
            new URLSearchParams(location.search).get('area') === 'run' ? 'run' : 'edit',
        );
        const [drawer, setDrawer] = useState(null);
        const [pending, setPending] = useState(null);
        function changeArea(key) {
            setArea(key);
            history.replaceState(null, '', base + 'realtime?area=' + key);
        }
        function save(values) {
            if (
                rows.some(
                    (row) =>
                        row.id !== values.id &&
                        row.name.toLowerCase() === values.name.toLowerCase(),
                )
            )
                return 'A configuration with this name already exists.';
            const record = { ...values, id: values.id || crypto.randomUUID() };
            commit(
                values.id
                    ? rows.map((row) => (row.id === values.id ? record : row))
                    : [record, ...rows],
            );
            setDrawer(null);
            message.success('Configuration saved');
        }
        function confirmAction() {
            const { action, record } = pending;
            commit(
                action === 'Delete'
                    ? rows.filter((row) => row.id !== record.id)
                    : rows.map((row) =>
                          row.id === record.id ? { ...row, online: action === 'Go Online' } : row,
                      ),
            );
            setPending(null);
        }
        const columns = [
            {
                title: 'Name',
                dataIndex: 'name',
                render: (name) => html`<strong className="record-name">${name}</strong>`,
            },
            { title: 'Application', dataIndex: 'application' },
            { title: 'Window', key: 'window', render: (_, row) => row.window + ' ' + row.unit },
            {
                title: 'Status',
                key: 'status',
                render: (_, row) =>
                    html`<span className=${row.online ? 'status online' : 'status'}
                        >${row.online ? 'Online' : 'Draft'}</span
                    >`,
            },
            {
                title: 'Actions',
                key: 'actions',
                render: (_, row) =>
                    html`<div className="actions">
                        ${area === 'edit' && html`<${ActionIcon} name="Edit" icon="edit" onClick=${() => setDrawer({ initial: row })} />`}
                        <${ActionIcon}
                            name=${row.online ? 'Go Offline' : 'Go Online'}
                            icon=${row.online ? 'pause-circle' : 'play-circle'}
                            onClick=${() => setPending({ action: row.online ? 'Go Offline' : 'Go Online', record: row })}
                        />
                        ${area === 'edit' && html`<${ActionIcon} name="Delete" icon="delete" onClick=${() => setPending({ action: 'Delete', record: row })} />`}
                    </div>`,
            },
        ];
        const visible = area === 'run' ? rows.filter((row) => row.online) : rows;
        return html`<main>
            <h1>Realtime Indicator</h1>
            <p className="intro">Configure event indicators and manage which ones run online.</p>
            <section className="surface">
                <${Tabs} activeKey=${area} onChange=${changeArea}>
                    <${Tabs.TabPane} tab="Edit Area" key="edit" /><${Tabs.TabPane}
                        tab="Run Area"
                        key="run"
                    />
                <//>
                <div className="table-heading">
                    <h2>
                        ${area === 'run' ? 'Online configurations' : 'Configurations'}
                        <span className="count">${visible.length}</span>
                    </h2>
                    ${area === 'edit' && html`<${Button} type="primary" onClick=${() => setDrawer({ initial: null })}>Add<//>`}
                </div>
                <div className="table-wrap">
                    <${Table}
                        rowKey="id"
                        columns=${columns}
                        dataSource=${visible}
                        pagination=${false}
                        size="middle"
                    />
                </div>
            </section>
            ${drawer && html`<${ConfigDrawer} initial=${drawer.initial} onClose=${() => setDrawer(null)} onSave=${save} />`}
            ${
                pending &&
                html`<${Modal}
                    visible=${true}
                    title=${pending.action}
                    okText="OK"
                    cancelText="Cancel"
                    onOk=${confirmAction}
                    onCancel=${() => setPending(null)}
                >
                    <p>
                        ${pending.action === 'Delete' ? 'Delete' : pending.action === 'Go Online' ? 'Bring online' : 'Take offline'}
                        “${pending.record.name}”?
                    </p>
                <//>`
            }
        </main>`;
    }
    function App() {
        const [rows, setRows] = useState(loadRecords);
        function commit(next) {
            localStorage.setItem(storageKey, JSON.stringify(next));
            setRows(next);
        }
        return html`<div className="shell">
            <${Navigation} />
            <div className="workspace">
                <header>
                    <span>Test workspace</span
                    ><span className="slash">/</span
                    >${onIndicators ? 'Indicator Center' : 'Overview'}
                </header>
                ${onIndicators ? html`<${Indicators} rows=${rows} commit=${commit} />` : html`<${Overview} rows=${rows} />`}
            </div>
        </div>`;
    }
    ReactDOM.render(html`<${App} />`, document.getElementById('root'));
}

const root = document.getElementById('root');
root.removeAttribute('aria-busy');
if (window.React && window.ReactDOM && window.antd && window.htm) startWorkspace();
else
    root.textContent =
        'The demo could not load its CDN libraries. Check access to cdn.jsdelivr.net and reload.';
