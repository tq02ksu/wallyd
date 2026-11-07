/**
 * agentd 日常界面。
 *
 * 导航只有四项：总览 / 任务 / 事件 / 设置。开发与诊断放在设置里的次级入口。
 *
 * 三条产品约束在代码里也有对应：
 * 1. 界面上**没有批准按钮**——审批只来自语音确认；这里只读地展示进展。
 * 2. 「取消任务」和「停止机器人」是两个不同东西，文案与位置都分开。
 * 3. 每个状态都带来源与观测时间；过期就写「状态已过期」，不把旧数据当现状。
 */
import { api, ApiError, initSession, listenEvents, stopBodyDirect } from './api.js';

// ---------------------------------------------------------------- DOM 助手
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};
const $ = (sel, root = document) => root.querySelector(sel);

// ---------------------------------------------------------------- 格式化
const pad = (n) => String(n).padStart(2, '0');
function localTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function localDay(iso) {
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  if (isToday) return '今天';
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fullTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} (${tz})`;
}
function relTime(ms) {
  if (ms === null || ms === undefined) return '未知';
  const s = Math.round(ms / 1000);
  if (s < 1) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.round(m / 60)} 小时前`;
}
function dur(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`;
}

const SEVERITY = {
  info: { cls: 'info', label: '正常' },
  warning: { cls: 'warn', label: '需要注意' },
  error: { cls: 'err', label: '故障' },
};
const RUN_STATUS = {
  accepted: ['muted', '已受理'],
  understanding: ['info', '理解中'],
  planning: ['info', '规划中'],
  waiting_input: ['warn', '需要补充信息'],
  waiting_confirmation: ['warn', '等待语音确认'],
  executing: ['info', '正在执行'],
  succeeded: ['ok', '已完成'],
  failed: ['err', '失败'],
  cancelled: ['muted', '已取消'],
  interrupted: ['warn', '被中断'],
  outcome_unknown: ['err', '结果待确认'],
};
const BODY_STATE = {
  ok: ['ok', '正常'],
  stale: ['warn', '状态已过期'],
  offline: ['err', '离线'],
  not_connected: ['unknown', '未接入'],
  unknown: ['unknown', '未知'],
};

function pill(cls, text) {
  return el('span', { class: `pill ${cls}` }, text);
}
function statusPill(status) {
  const [cls, label] = RUN_STATUS[status] ?? ['muted', status];
  return pill(cls, label);
}
function severityPill(sev) {
  const s = SEVERITY[sev] ?? SEVERITY.info;
  return pill(s.cls, s.label);
}

// ---------------------------------------------------------------- 全局状态
const state = {
  route: 'overview',
  overview: null,
  routeDetailRunId: null,
  routeDetailSessionId: null,
  overviewTimer: null,
  live: null,
  wsStatus: 'connecting',
  pendingNew: 0,
  events: [],
  eventsCursor: null,
  eventsHasMore: false,
  eventsFilters: { severity: '', source: '', q: '', run_id: '' },
  eventsPaused: false,
  runs: [],
  runsFilter: '',
  runsCursor: null,
  profiles: null,
  activeProfileId: null,
  draft: null,
  validation: null,
  banner: null,
};

function setBanner(kind, text, actions = []) {
  state.banner = { kind, text, actions };
  renderBanner();
}
function clearBanner() {
  state.banner = null;
  renderBanner();
}
function renderBanner() {
  const host = $('#banner');
  host.replaceChildren();
  const b = state.banner;
  if (!b) return;
  const node = el(
    'div',
    { class: `notice ${b.kind}`, role: b.kind === 'error' ? 'alert' : 'status' },
    el('span', { class: 'grow' }, b.text),
    ...b.actions.map((a) =>
      el('button', { class: 'btn btn-sm', onclick: a.onClick }, a.label),
    ),
    el('button', { class: 'btn ghost btn-sm', onclick: clearBanner, 'aria-label': '关闭提示' }, '×'),
  );
  host.append(node);
}

// ---------------------------------------------------------------- 路由
const ROUTES = ['overview', 'runs', 'events', 'settings'];

function parseHash() {
  const raw = (location.hash || '#/overview').replace(/^#\/?/, '');
  const [head, ...rest] = raw.split('/');
  if (head === 'runs' && rest[0]) return { route: 'runs', id: rest[0] };
  if (head === 'sessions' && rest[0]) return { route: 'runs', session: rest[0] };
  if (ROUTES.includes(head)) return { route: head, id: rest[0] ?? null };
  if (head === 'diagnostics') return { route: 'settings', id: 'diagnostics' };
  return { route: 'overview' };
}

function navigate(route, id) {
  location.hash = `#/${route}${id ? `/${id}` : ''}`;
}

async function onRouteChange() {
  const parsed = parseHash();
  state.route = parsed.route;
  state.routeDetailRunId = parsed.route === 'runs' ? parsed.id : null;
  for (const a of document.querySelectorAll('.nav a')) {
    a.setAttribute('aria-current', a.dataset.route === parsed.route ? 'page' : 'false');
  }
  stopOverviewPolling();
  const main = $('#main');
  main.replaceChildren(el('div', { class: 'empty' }, el('span', { class: 'spin' }), ' 正在加载…'));
  try {
    if (parsed.route === 'overview') await renderOverview();
    else if (parsed.route === 'runs') await renderRuns(parsed.id);
    else if (parsed.route === 'events') await renderEvents();
    else await renderSettings(parsed.id);
  } catch (e) {
    main.replaceChildren(renderError(e));
  }
}

function renderError(e) {
  const hint = e instanceof ApiError ? e.hint : null;
  return el(
    'div',
    { class: 'card' },
    el('h2', { text: '加载失败' }),
    el('p', { class: 'muted', text: e.message ?? String(e) }),
    hint ? el('p', { class: 'small muted', text: `建议：${hint}` }) : null,
    e instanceof ApiError && e.code === 'E_STORE'
      ? el('p', { class: 'small', text: '历史库不可写，为安全起见不会有任何副作用被记录。停止机器人不受影响。' })
      : null,
  );
}

// ---------------------------------------------------------------- 总览
function stopOverviewPolling() {
  if (state.overviewTimer) clearInterval(state.overviewTimer);
  state.overviewTimer = null;
}

async function renderOverview() {
  const main = $('#main');
  const data = await api.state();
  state.overview = data;

  const head = el(
    'div',
    { class: 'page-head' },
    el('h1', { text: '总览' }),
    el('span', {
      class: 'meta',
      text: data.body.observed_at
        ? `更新于 ${relTime(data.body.freshness?.age_ms)}`
        : '尚未取得身体状态',
    }),
  );

  main.replaceChildren(head);

  // ---- 首要问题（只显示最该先处理的那一个，其余折叠）
  if (data.issues.length > 0) {
    const first = data.issues[0];
    const rest = data.issues.slice(1);
    const kind = first.severity === 'error' ? 'error' : first.severity === 'warning' ? 'warning' : 'info';
    const label = first.severity === 'error' ? '故障' : first.severity === 'warning' ? '需要注意' : '提示';
    const actions = [];
    if (first.action?.startsWith('settings')) {
      actions.push(el('button', { class: 'btn btn-sm', onclick: () => navigate('settings') }, '打开设置'));
    } else if (first.action?.startsWith('diagnostics')) {
      actions.push(el('button', { class: 'btn btn-sm', onclick: () => navigate('settings', 'diagnostics') }, '查看诊断'));
    }
    main.append(
      el(
        'div',
        { class: `notice ${kind}` },
        el('span', { class: 'grow' }, el('strong', { text: `${label}：` }), first.title, first.detail ? `。${first.detail}` : ''),
        ...actions,
      ),
    );
    if (rest.length > 0) {
      main.append(
        el(
          'details',
          { class: 'card' },
          el('summary', { text: `还有 ${rest.length} 个问题` }),
          el(
            'ul',
            { style: 'margin:10px 0 0; padding-left:20px' },
            ...rest.map((i) =>
              el(
                'li',
                {},
                el('strong', { text: i.title }),
                i.detail ? el('span', { class: 'muted', text: ` — ${i.detail}` }) : null,
              ),
            ),
          ),
        ),
      );
    }
  }

  // ---- 当前任务
  main.append(renderCurrentTask(data.active_run));

  // ---- 状态卡（身体 / 大脑）
  main.append(
    el(
      'div',
      { class: 'grid2' },
      renderBodyCard(data.body),
      renderBrainCard(data.brain),
    ),
  );

  // ---- 输入
  main.append(renderInputCard());

  // ---- 最近事件
  const recent = data.recent_events ?? [];
  main.append(
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'card-head' },
        el('h2', { text: '最近发生的事' }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn ghost btn-sm', onclick: () => navigate('events') }, '全部事件'),
      ),
      recent.length === 0
        ? el('div', { class: 'empty', text: '尚无事件' })
        : el(
            'div',
            {},
            ...recent.map((ev) =>
              el(
                'div',
                { class: 'event' },
                el('time', { text: localTime(ev.occurred_at), title: fullTime(ev.occurred_at) }),
                el(
                  'div',
                  {},
                  el(
                    'div',
                    { class: 'event-title' },
                    ev.title,
                    ev.severity !== 'info' ? severityPill(ev.severity) : null,
                    ev.recovered ? pill('ok', '已恢复') : null,
                  ),
                  ev.summary ? el('div', { class: 'event-summary', text: ev.summary }) : null,
                ),
              ),
            ),
          ),
    ),
  );

  // 15 秒轮询一次总览（WS 只推动事件，不推聚合状态）
  stopOverviewPolling();
  state.overviewTimer = setInterval(async () => {
    if (state.route !== 'overview') return;
    try {
      const fresh = await api.state();
      state.overview = fresh;
      // 只更新动态区，不重建整页（避免打断输入）
      refreshOverviewDynamic(fresh);
    } catch {
      /* 轮询失败不打断页面；顶部连接指示会反映 */
    }
  }, 15000);
}

function refreshOverviewDynamic(data) {
  const taskHost = $('#current-task');
  if (taskHost) taskHost.replaceWith(withId(renderCurrentTask(data.active_run), 'current-task'));
  const bodyHost = $('#body-card');
  if (bodyHost) bodyHost.replaceWith(withId(renderBodyCard(data.body), 'body-card'));
  const brainHost = $('#brain-card');
  if (brainHost) brainHost.replaceWith(withId(renderBrainCard(data.brain), 'brain-card'));
  const meta = $('.page-head .meta');
  if (meta && data.body.observed_at) meta.textContent = `更新于 ${relTime(data.body.freshness?.age_ms)}`;
}

function withId(node, id) {
  node.id = id;
  return node;
}

function renderCurrentTask(run) {
  if (!run) {
    return withId(
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', { text: '当前任务' })),
        el('div', { class: 'muted', text: '空闲，等待请求。' }),
      ),
      'current-task',
    );
  }
  const [cls, label] = RUN_STATUS[run.status] ?? ['muted', run.status];
  return withId(
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', { text: '当前任务' }), el('span', { class: 'spacer' }), pill(cls, label)),
      el('div', { style: 'font-size:16px; font-weight:550; margin-bottom:4px', text: `「${run.prompt}」` }),
      run.blocking_reason ? el('div', { class: 'muted small', text: run.blocking_reason }) : null,
      el(
        'div',
        { class: 'row', style: 'margin-top:12px' },
        el('button', { class: 'btn btn-sm', onclick: () => navigate('runs', run.run_id) }, '查看任务'),
        el(
          'button',
          {
            class: 'btn btn-sm',
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                await api.cancelRun(run.run_id, '用户取消');
                setBanner('info', '已取消任务。取消只终止编排；机器人是否停稳要看停止结果。');
                await renderOverview();
              } catch (err) {
                setBanner('error', `取消失败：${err.message}`);
              }
            },
          },
          '取消任务',
        ),
        el('span', { class: 'small muted', text: '取消任务 ≠ 停止机器人' }),
      ),
    ),
    'current-task',
  );
}

function renderBodyCard(body) {
  const [cls, label] = BODY_STATE[body.state] ?? ['unknown', body.state];
  const fresh = body.freshness ?? {};
  const stale = fresh.expired === true;
  const robot = body.robot;
  const devices = robot?.devices ?? {};
  const battery = robot?.battery;

  const batteryText = !battery
    ? '未知（无上报）'
    : battery.percent === null || battery.percent === undefined
      ? battery.source === 'unimplemented'
        ? '未知（无上报）'
        : `未知（来源：${battery.source}）`
      : `${battery.percent}%`;

  return withId(
    el(
      'div',
      { class: `card ${stale ? 'stale' : ''}` },
      el(
        'div',
        { class: 'card-head' },
        el('h2', { text: '身体 · robotd' }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'conn' }, el('span', { class: `dot ${cls === 'unknown' ? 'unknown' : cls}` }), label),
      ),
      el(
        'dl',
        { class: 'kv' },
        el('dt', { text: '模式' }),
        el('dd', { text: robot?.mode ?? '—' }),
        el('dt', { text: '电量' }),
        el('dd', { text: batteryText }),
        el('dt', { text: '姿态' }),
        el(
          'dd',
          {
            text: robot?.pose
              ? robot.pose.valid
                ? `x=${robot.pose.x.toFixed(2)} y=${robot.pose.y.toFixed(2)} θ=${robot.pose.rad?.toFixed(2) ?? robot.pose.theta?.toFixed(2)}`
                : '未知（位姿无效）'
              : '—',
          },
        ),
        el('dt', { text: '设备' }),
        el(
          'dd',
          {},
          Object.keys(devices).length === 0
            ? '—'
            : Object.entries(devices)
                .map(([k, v]) => `${k}:${v}`)
                .join(' · '),
        ),
        el('dt', { text: '最近观测' }),
        el(
          'dd',
          {},
          body.observed_at
            ? el('span', { class: stale ? '' : 'mono', text: `${localTime(body.observed_at)}${stale ? '（已过期）' : ''}` })
            : '—',
        ),
      ),
      body.note ? el('div', { class: 'small muted', style: 'margin-top:10px', text: body.note }) : null,
    ),
    'body-card',
  );
}

function renderBrainCard(brain) {
  const model = brain.model ?? {};
  const hv = brain.harness ?? {};
  const modelLabel =
    model.state === 'active'
      ? `${model.active_profile_name} v${model.active_revision}`
      : model.state === 'invalid'
        ? '未通过验证'
        : '未连接';
  const modelCls = model.state === 'active' ? 'ok' : model.state === 'invalid' ? 'warn' : 'unknown';
  const harnessLabel =
    hv.state === 'ready'
      ? '就绪'
      : hv.state === 'running'
        ? '运行中'
        : hv.state === 'not_configured'
          ? '未配置'
          : '不可用';
  const harnessCls = hv.state === 'ready' || hv.state === 'running' ? 'ok' : hv.state === 'not_configured' ? 'unknown' : 'err';

  return withId(
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'card-head' },
        el('h2', { text: '大脑 · agentd' }),
        el('span', { class: 'spacer' }),
        el(
          'span',
          { class: 'conn' },
          el('span', { class: `dot ${brain.daemon === 'ok' ? 'ok' : 'warn'}` }),
          brain.daemon === 'ok' ? '正常' : '降级',
        ),
      ),
      el(
        'dl',
        { class: 'kv' },
        el('dt', { text: '高级模型' }),
        el('dd', {}, el('span', { class: `dot ${modelCls}` }), ` ${modelLabel}`),
        el('dt', { text: 'Harness' }),
        el('dd', {}, el('span', { class: `dot ${harnessCls}` }), ` ${harnessLabel}`),
        el('dt', { text: '历史库' }),
        el('dd', { text: brain.store === 'ok' ? '可写' : brain.store === 'read_only' ? '只读（降级）' : '故障' }),
        el('dt', { text: '确认方式' }),
        el('dd', { text: hv.approval_mode === 'voice' ? '语音确认' : hv.approval_mode === 'manual_test' ? '手工批准（测试模式）' : '自动（测试模式）' }),
        // CODEX_HOME 必须露出来给用户核对：agentd 用的是自己的沙箱目录，
        // 不是主机 ~/.codex。不显示这一行，用户就没法判断自己的会话历史有没有被串。
        // 独占整行（.wide），否则长路径会在右半列折成两行读不全。
        hv.codex_home
          ? el('dt', {
              class: 'inline-w',
              text: '会话沙箱',
              title: 'Harness 专属 CODEX_HOME；agentd 不读写主机的 ~/.codex',
            })
          : null,
        hv.codex_home ? el('dd', { class: 'mono wide', text: hv.codex_home }) : null,
      ),
      model.state !== 'active'
        ? el('div', { style: 'margin-top:10px' }, el('button', { class: 'btn btn-sm', onclick: () => navigate('settings') }, '配置高级模型'))
        : null,
    ),
    'brain-card',
  );
}

function renderInputCard() {
  const input = el('input', {
    class: 'input',
    placeholder: '例如：往前走一米',
    'aria-label': '输入请求',
    maxlength: '4000',
  });
  const send = el('button', { class: 'btn primary', text: '发送' });
  const status = el('div', { class: 'small muted', style: 'margin-top:8px' });

  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    status.textContent = '正在提交…';
    try {
      const res = await api.submitRun({
        prompt: text,
        idempotency_key: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      if (res.run_id) {
        input.value = '';
        status.textContent = '';
        navigate('runs', res.run_id);
      } else if (res.clarify?.question) {
        // 澄清不建 run（没有任务可跳），把追问留在输入卡上，让用户补一句
        status.textContent = res.clarify.question;
      } else if (Array.isArray(res.ambiguous) && res.ambiguous.length > 0) {
        status.textContent = `有多条规则同时命中（${res.ambiguous.join(' / ')}），请说得更具体一些。`;
      } else {
        status.textContent = '已受理。';
      }
    } catch (e) {
      if (e.code === 'E_BUSY') {
        status.replaceChildren(
          el('span', { text: '已有任务在进行中。' }),
          el('button', { class: 'btn ghost btn-sm', onclick: () => navigate('runs', e.details?.run_id ?? '') }, '查看当前任务'),
        );
      } else if (e.code === 'E_STORE') {
        status.textContent = `历史库不可写，为安全起见不启动任务：${e.message}`;
      } else {
        status.textContent = `提交失败：${e.message}`;
      }
    } finally {
      send.disabled = false;
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  send.addEventListener('click', submit);

  return el(
    'div',
    { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '输入请求' })),
    el('div', { class: 'row' }, el('div', { class: 'grow' }, input), send),
    status,
  );
}

// ---------------------------------------------------------------- 任务
async function renderRuns(runId) {
  const main = $('#main');
  if (runId) {
    const detail = await api.getRun(runId);
    main.replaceChildren(renderRunDetail(detail));
    return;
  }
  const data = await api.listRuns({ status: state.runsFilter || undefined, limit: 50 });
  state.runs = data.runs;

  const head = el('div', { class: 'page-head' }, el('h1', { text: '任务' }), el('span', { class: 'meta', text: `共 ${data.runs.length} 条` }));

  const filters = el(
    'div',
    { class: 'row', style: 'margin-bottom:12px' },
    ...['', 'executing', 'waiting_confirmation', 'succeeded', 'failed', 'cancelled'].map((s) =>
      el(
        'button',
        {
          class: `btn btn-sm ${state.runsFilter === s ? 'primary' : ''}`,
          onclick: async () => {
            state.runsFilter = s;
            await renderRuns();
          },
        },
        s === '' ? '全部' : (RUN_STATUS[s]?.[1] ?? s),
      ),
    ),
  );

  const rows =
    data.runs.length === 0
      ? el('div', { class: 'empty', text: state.runsFilter ? '没有符合条件的事件' : '还没有任务' })
      : el(
          'table',
          { class: 'list' },
          el(
            'thead',
            {},
            el('tr', {}, el('th', { text: '请求' }), el('th', { text: '状态' }), el('th', { text: '开始' }), el('th', { text: '耗时' }), el('th', { text: '来源' })),
          ),
          el(
            'tbody',
            {},
            ...data.runs.map((r) =>
              el(
                'tr',
                { onclick: () => navigate('runs', r.run_id) },
                el('td', {}, el('div', { text: r.prompt }), r.blocking_reason ? el('div', { class: 'small muted', text: r.blocking_reason }) : null),
                el('td', {}, statusPill(r.status)),
                el('td', { class: 'mono small', text: localTime(r.created_at), title: fullTime(r.created_at) }),
                el('td', { class: 'mono small', text: dur(r.duration_ms) }),
                el('td', { class: 'small muted', text: r.source === 'asr' ? '语音' : '文本' }),
              ),
            ),
          ),
        );

  main.replaceChildren(head, filters, el('div', { class: 'card', style: 'padding:0' }, rows));
}

function renderRunDetail(detail) {
  const run = detail.run;
  const [cls] = RUN_STATUS[run.status] ?? ['muted'];

  const head = el(
    'div',
    { class: 'page-head' },
    el('button', { class: 'btn btn-sm', onclick: () => navigate('runs') }, '← 返回'),
    el('h1', { text: '任务详情' }),
    el('span', { class: 'spacer' }),
    statusPill(run.status),
  );

  const top = el(
    'div',
    { class: 'card' },
    el('div', { style: 'font-size:16px; font-weight:550', text: `「${run.prompt}」` }),
    run.blocking_reason ? el('div', { class: 'muted small', style: 'margin-top:4px', text: `当前阻塞：${run.blocking_reason}` }) : null,
    el(
      'dl',
      { class: 'kv', style: 'margin-top:12px' },
      el('dt', { text: '任务标识' }),
      el('dd', { class: 'mono small', text: run.run_id }),
      el('dt', { text: '开始时间' }),
      el('dd', { class: 'mono small', text: fullTime(run.created_at) }),
      el('dt', { text: '耗时' }),
      el('dd', { class: 'mono small', text: dur(run.duration_ms) }),
      el('dt', { text: '输入来源' }),
      el('dd', { text: run.source === 'asr' ? '语音' : '文本' }),
      el('dt', { text: '执行路径' }),
      el('dd', { text: run.route === 'fast' ? '确定性快速路由' : run.route === 'harness' ? '交给高级模型理解' : '需要澄清' }),
      run.model_revision ? el('dt', { text: '模型配置' }) : null,
      run.model_revision ? el('dd', { class: 'mono small', text: `v${run.model_revision}` }) : null,
    ),
    run.status !== 'succeeded' && run.status !== 'cancelled' && run.status !== 'failed' && run.status !== 'interrupted' && run.status !== 'outcome_unknown'
      ? el(
          'div',
          { class: 'row', style: 'margin-top:12px' },
          el(
            'button',
            {
              class: 'btn btn-sm',
              onclick: async () => {
                try {
                  await api.cancelRun(run.run_id, '用户取消');
                  setBanner('info', '已取消。取消只终止编排，不等于机器人已停稳。');
                  navigate('runs', run.run_id);
                } catch (e) {
                  setBanner('error', `取消失败：${e.message}`);
                }
              },
            },
            '取消任务',
          ),
          el('span', { class: 'small muted', text: '要停止机器人，请用底部的「停止机器人」' }),
        )
      : null,
  );

  // 步骤
  const steps =
    detail.steps.length === 0
      ? el('div', { class: 'muted small', text: '还没有步骤记录。' })
      : el(
          'div',
          { class: 'steps' },
          ...detail.steps.map((s) =>
            el('span', { class: `step ${s.state}`, title: s.note ?? '' }, `${s.title} · ${stepLabel(s.state)}`),
          ),
        );

  // 工具调用
  const calls =
    detail.tool_calls.length === 0
      ? el('div', { class: 'muted small', text: '没有工具调用。' })
      : el(
          'div',
          {},
          ...detail.tool_calls.map((c) =>
            el(
              'div',
              { style: 'padding:8px 0; border-bottom:1px solid var(--border)' },
              el(
                'div',
                { class: 'row' },
                el('strong', { text: c.action_label ?? c.capability }),
                el('span', { class: 'small muted', text: c.capability }),
                el('span', { class: 'spacer', style: 'margin-left:auto' }),
                pill(callPill(c.state), callLabel(c.state)),
              ),
              el('div', { class: 'small muted', text: `参数：${c.args_summary}` }),
              c.evidence ? el('div', { class: 'small', text: `依据：${c.evidence}` }) : null,
              c.robot_task_id ? el('div', { class: 'small mono muted', text: `robotd task ${c.robot_task_id}` }) : null,
            ),
          ),
        );

  // 审批（只读！）
  const approvals =
    detail.approvals.length === 0
      ? el('div', { class: 'muted small', text: '没有审批记录。' })
      : el(
          'div',
          {},
          ...detail.approvals.map((a) =>
            el(
              'div',
              { style: 'padding:8px 0; border-bottom:1px solid var(--border)' },
              el(
                'div',
                { class: 'row' },
                el('strong', { text: a.action_label ?? a.capability }),
                el('span', { class: 'spacer', style: 'margin-left:auto' }),
                pill(approvalPill(a.status), approvalLabel(a.status)),
              ),
              el('div', { class: 'small muted', text: `复述：${a.prompt_text}` }),
              a.decided_by
                ? el('div', { class: 'small muted', text: `结论来源：${deciderLabel(a.decided_by)}` })
                : a.window_closes_at
                  ? el('div', { class: 'small muted', text: `确认窗口至 ${localTime(a.window_closes_at)}` })
                  : null,
            ),
          ),
        );

  // 结果
  const result = el(
    'dl',
    { class: 'kv' },
    el('dt', { text: '结论' }),
    el('dd', { text: outcomeLabel(detail.result.outcome) }),
    el('dt', { text: '已完成' }),
    el('dd', { text: detail.result.completed_steps.length ? detail.result.completed_steps.join('、') : '无' }),
    el('dt', { text: '未完成' }),
    el('dd', { text: detail.result.incomplete_steps.length ? detail.result.incomplete_steps.join('、') : '无' }),
    detail.result.reason ? el('dt', { text: '说明' }) : null,
    detail.result.reason ? el('dd', { text: detail.result.reason }) : null,
    el('dt', { text: 'robotd 任务' }),
    el('dd', { class: 'mono small', text: detail.result.robot_task_ids.length ? detail.result.robot_task_ids.join(', ') : '无' }),
  );

  const diag = el(
    'details',
    { class: 'card' },
    el('summary', { text: '诊断' }),
    el(
      'dl',
      { class: 'kv', style: 'margin-top:10px' },
      el('dt', { text: 'Harness 退出码' }),
      el('dd', { class: 'mono small', text: String(detail.diagnostics?.harness_exit_code ?? '—') }),
      el('dt', { text: '错误码' }),
      el('dd', { class: 'mono small', text: detail.diagnostics?.error_code ?? '—' }),
      el('dt', { text: '配置 revision' }),
      el('dd', { class: 'mono small', text: String(detail.diagnostics?.config_revision ?? '—') }),
    ),
    el('div', { style: 'margin-top:10px' }, el('button', { class: 'btn btn-sm', onclick: () => navigate('events') }, '查看关联事件')),
  );

  return el(
    'div',
    {},
    head,
    setBannerHost(),
    top,
    el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '步骤' })), steps),
    el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '工具调用' })), calls),
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', { text: '审批' }), el('span', { class: 'spacer' }), el('span', { class: 'small muted', text: '只读 · 批准只能来自语音确认' })),
      approvals,
    ),
    el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '结果' })), result),
    diag,
  );
}

function setBannerHost() {
  return el('div', { id: 'inline-banner' });
}
function stepLabel(state) {
  return { done: '已完成', active: '进行中', waiting: '等待中', pending: '未开始', failed: '失败', skipped: '已跳过' }[state] ?? state;
}
function callLabel(state) {
  return {
    requested: '已请求',
    awaiting_approval: '等待确认',
    running: '执行中',
    succeeded: '成功',
    failed: '失败',
    outcome_unknown: '结果待确认',
    denied: '已拒绝',
  }[state] ?? state;
}
function callPill(state) {
  return state === 'succeeded' ? 'ok' : state === 'failed' || state === 'outcome_unknown' ? 'err' : state === 'denied' ? 'muted' : state === 'awaiting_approval' ? 'warn' : 'info';
}
function approvalLabel(status) {
  return {
    persisted: '已记录',
    announced: '已播报',
    waiting: '等待确认',
    approved: '已确认',
    denied: '已拒绝',
    expired: '已超时',
    timeout: '已超时',
    cancelled: '已取消',
  }[status] ?? status;
}
function approvalPill(status) {
  return status === 'approved' ? 'ok' : status === 'denied' || status === 'expired' || status === 'timeout' ? 'err' : status === 'waiting' || status === 'announced' ? 'warn' : 'muted';
}
function deciderLabel(by) {
  return { voice: '语音确认', timeout: '超时', cancel: '随任务取消', manual_test: '手工（测试模式）', system: '系统' }[by] ?? by;
}
function outcomeLabel(o) {
  return {
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '被中断',
    outcome_unknown: '结果待确认（不能当作未执行）',
    in_progress: '进行中',
  }[o] ?? o;
}

// ---------------------------------------------------------------- 事件
async function renderEvents({ append = false } = {}) {
  const main = $('#main');
  const filters = state.eventsFilters;
  const data = await api.listEvents({
    limit: 50,
    cursor: append ? state.eventsCursor : undefined,
    severity: filters.severity || undefined,
    source: filters.source || undefined,
    q: filters.q || undefined,
    run_id: filters.run_id || undefined,
  });

  if (append) state.events = [...state.events, ...data.events];
  else state.events = data.events;
  state.eventsCursor = data.next_cursor;
  state.eventsHasMore = Boolean(data.next_cursor);
  state.pendingNew = 0;

  if (!append) {
    const head = el('div', { class: 'page-head' }, el('h1', { text: '事件' }), el('span', { class: 'meta', text: '人类可读的时间线' }));

    const sevSel = el('select', {
      class: 'select',
      onchange: async (e) => { state.eventsFilters.severity = e.target.value; await renderEvents(); },
    },
      el('option', { value: '' }, '全部级别'),
      el('option', { value: 'info', selected: filters.severity === 'info' }, '正常'),
      el('option', { value: 'warning', selected: filters.severity === 'warning' }, '需要注意'),
      el('option', { value: 'error', selected: filters.severity === 'error' }, '故障'),
    );
    const srcSel = el('select', {
      class: 'select',
      onchange: async (e) => { state.eventsFilters.source = e.target.value; await renderEvents(); },
    },
      el('option', { value: '' }, '全部来源'),
      ...['agentd', 'robotd', 'harness', 'model', 'store', 'user'].map((s) =>
        el('option', { value: s, selected: filters.source === s }, s),
      ),
    );
    const search = el('input', {
      class: 'input',
      placeholder: '搜索标题、摘要或错误码…',
      value: filters.q,
      onkeydown: async (e) => { if (e.key === 'Enter') { state.eventsFilters.q = e.target.value; await renderEvents(); } },
    });
    const pause = el('button', {
      class: `btn btn-sm ${state.eventsPaused ? 'primary' : ''}`,
      onclick: () => { state.eventsPaused = !state.eventsPaused; renderEvents(); },
    }, state.eventsPaused ? '恢复实时更新' : '暂停实时更新');

    main.replaceChildren(
      head,
      el('div', { class: 'row', style: 'margin-bottom:12px; flex-wrap:wrap' }, sevSel, srcSel, el('div', { class: 'grow' }, search), pause),
      el('div', { id: 'new-events-host' }),
      el('div', { class: 'card', id: 'events-list', style: 'padding:8px 16px' }),
      el('div', { id: 'events-footer', style: 'text-align:center; padding:12px' }),
    );
  }

  renderEventList();
}

function renderEventList() {
  const host = $('#events-list');
  if (!host) return;
  const list = state.events;
  if (list.length === 0) {
    const hasFilter = Object.values(state.eventsFilters).some(Boolean);
    host.replaceChildren(el('div', { class: 'empty', text: hasFilter ? '没有符合条件的事件' : '尚无事件' }));
  } else {
    const groups = new Map();
    for (const ev of list) {
      const day = localDay(ev.occurred_at);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(ev);
    }
    const nodes = [];
    for (const [day, evs] of groups) {
      nodes.push(el('div', { class: 'day-head', text: day }));
      for (const ev of evs) nodes.push(renderEventRow(ev));
    }
    host.replaceChildren(...nodes);
  }

  const footer = $('#events-footer');
  if (footer) {
    // 注意：replaceChildren 不像 el() 那样过滤 null——传 null 会被当成文本节点渲染成 "null"。
    const parts = [el('span', { class: 'small muted', text: `显示 ${list.length} 条` })];
    if (state.eventsHasMore) {
      parts.push(
        el('button', { class: 'btn btn-sm', style: 'margin-left:12px', onclick: () => renderEvents({ append: true }) }, '加载更早事件'),
      );
    }
    footer.replaceChildren(...parts);
  }
}

function renderEventRow(ev) {
  const detailId = `d-${ev.event_id}`;
  const detail = el(
    'dl',
    { class: 'event-detail', id: detailId, hidden: true },
    el('dt', { text: '事件类型' }),
    el('dd', { class: 'mono', text: ev.type }),
    el('dt', { text: '事件 ID' }),
    el('dd', { class: 'mono', text: ev.event_id }),
    el('dt', { text: '游标' }),
    el('dd', { class: 'mono', text: ev.cursor }),
    el('dt', { text: '完整时间' }),
    el('dd', { text: fullTime(ev.occurred_at) }),
    el('dt', { text: '来源' }),
    el('dd', { class: 'mono', text: ev.source }),
    ev.run_id ? el('dt', { text: '任务' }) : null,
    ev.run_id ? el('dd', { class: 'mono', text: ev.run_id }) : null,
    ev.approval_id ? el('dt', { text: '审批' }) : null,
    ev.approval_id ? el('dd', { class: 'mono', text: ev.approval_id }) : null,
    ev.robot_task_id ? el('dt', { text: 'robotd 任务' }) : null,
    ev.robot_task_id ? el('dd', { class: 'mono', text: ev.robot_task_id }) : null,
    ev.code ? el('dt', { text: '错误码' }) : null,
    ev.code ? el('dd', { class: 'mono', text: ev.code }) : null,
    ev.data
      ? el('dd', { class: 'mono', style: 'grid-column:1/-1; margin-top:6px; white-space:pre-wrap', text: JSON.stringify(ev.data, null, 2) })
      : null,
  );

  const actions = el('div', { class: 'event-actions' });
  if (ev.run_id) {
    actions.append(el('button', { class: 'btn ghost btn-sm', onclick: () => navigate('runs', ev.run_id) }, '查看任务'));
  }
  if (ev.type.startsWith('model.')) {
    actions.append(el('button', { class: 'btn ghost btn-sm', onclick: () => navigate('settings') }, '打开设置'));
  }
  actions.append(
    el(
      'button',
      {
        class: 'btn ghost btn-sm',
        onclick: (e) => {
          const d = document.getElementById(detailId);
          d.hidden = !d.hidden;
          e.target.textContent = d.hidden ? '展开详情' : '收起详情';
        },
      },
      '展开详情',
    ),
  );

  return el(
    'div',
    { class: 'event' },
    el('time', { text: localTime(ev.occurred_at), title: fullTime(ev.occurred_at) }),
    el(
      'div',
      {},
      el(
        'div',
        { class: 'event-title' },
        ev.title,
        ev.severity !== 'info' ? severityPill(ev.severity) : null,
        ev.recovered ? pill('ok', '已恢复') : null,
        ev.type.startsWith('未知') ? pill('muted', '未登记类型') : null,
      ),
      ev.summary ? el('div', { class: 'event-summary', text: ev.summary }) : null,
      ev.impact ? el('div', { class: 'small muted', text: `影响：${ev.impact}` }) : null,
      ev.advice ? el('div', { class: 'small muted', text: `建议：${ev.advice}` }) : null,
      actions.childElementCount ? actions : null,
      detail,
    ),
  );
}

// ---------------------------------------------------------------- 设置
async function renderSettings(section) {
  const main = $('#main');
  if (section === 'diagnostics') {
    await renderDiagnostics();
    return;
  }
  const data = await api.listProfiles();
  state.profiles = data.profiles ?? [];
  state.activeProfileId = data.active_profile_id;

  const current = state.profiles.find((p) => p.active);
  const head = el('div', { class: 'page-head' }, el('h1', { text: '设置' }), el('span', { class: 'meta', text: '高级模型' }));

  const summaryRow = el(
    'div',
    { class: 'card' },
    el(
      'dl',
      { class: 'kv' },
      el('dt', { text: '当前默认' }),
      el('dd', { text: current ? `${current.name} v${current.active_revision}` : '未配置' }),
      el('dt', { text: '数据边界' }),
      el('dd', { text: '仅本机' }),
      el('dt', { text: '外部模型' }),
      el('dd', { text: '未开放，需先确认数据边界政策' }),
    ),
  );

  // 配置选择器
  const picker = el(
    'div',
    { class: 'row', style: 'margin-bottom:12px' },
    el(
      'select',
      {
        class: 'select',
        style: 'max-width:260px',
        onchange: async (e) => {
          state.draft = null;
          state.validation = null;
          await renderSettings();
          if (e.target.value) await loadProfile(e.target.value);
        },
      },
      el('option', { value: '' }, state.profiles.length ? '选择一个配置…' : '还没有配置'),
      ...state.profiles.map((p) => el('option', { value: p.profile_id, selected: state.draft?.profile_id === p.profile_id }, `${p.name} v${p.latest_revision}${p.active ? '（默认）' : ''}`)),
    ),
    el('button', { class: 'btn btn-sm', onclick: () => startNewProfile() }, '新建配置'),
  );

  main.replaceChildren(head, summaryRow, picker, el('div', { id: 'profile-editor' }), renderDiagnosticsLink());

  if (state.draft) renderProfileEditor();
  else if (state.profiles.length === 0) {
    $('#profile-editor').replaceChildren(
      el(
        'div',
        { class: 'card' },
        el('p', { text: '还没有配置高级模型。' }),
        el('p', { class: 'small muted', text: '未配置时仍可使用总览、历史、停止与确定性指令；复杂任务需要先配置兼容模型。' }),
        el('button', { class: 'btn primary', onclick: () => startNewProfile() }, '新建配置'),
      ),
    );
  }
}

function renderDiagnosticsLink() {
  return el(
    'div',
    { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '开发与诊断' })),
    el('p', { class: 'small muted', text: 'robotd 直连、原始事件、契约版本等维护入口。日常使用不需要这里。' }),
    el(
      'div',
      { class: 'row' },
      el('button', { class: 'btn btn-sm', onclick: () => navigate('settings', 'diagnostics') }, '打开诊断'),
      el('a', { class: 'btn btn-sm', href: 'http://127.0.0.1:8787/v1/health', target: '_blank', rel: 'noopener' }, 'robotd 健康检查'),
    ),
  );
}

function startNewProfile() {
  state.draft = {
    profile_id: null,
    revision: null,
    base_revision: null,
    name: '',
    provider: 'openai_compatible',
    endpoint: 'http://127.0.0.1:8790/v1',
    model: '',
    credential: '',
    clear_credential: false,
    credential_set: false,
    reasoning_effort: '',
    max_output_tokens: '',
    temperature: '',
    request_timeout_ms: '',
    budget_tokens: '',
    data_boundary: 'local_only',
    revisions: [],
    active: false,
  };
  state.validation = null;
  renderProfileEditor();
}

async function loadProfile(profileId) {
  const data = await api.getProfile(profileId);
  const latest = data.revisions[0];
  state.draft = {
    profile_id: profileId,
    revision: latest.revision,
    base_revision: latest.revision,
    name: latest.name,
    provider: latest.provider,
    endpoint: latest.endpoint,
    model: latest.model,
    credential: '',
    clear_credential: false,
    credential_set: latest.credential_set,
    reasoning_effort: latest.reasoning_effort ?? '',
    max_output_tokens: latest.max_output_tokens ?? '',
    temperature: latest.temperature ?? '',
    request_timeout_ms: latest.request_timeout_ms ?? '',
    budget_tokens: latest.budget_tokens ?? '',
    data_boundary: latest.data_boundary ?? 'local_only',
    revisions: data.revisions,
    active: data.profile.active,
    active_revision: data.profile.active_revision,
    validation: latest.validation,
  };
  renderProfileEditor();
}

function field(label, input, hint) {
  return el('div', { class: 'field' }, el('label', { text: label }), input, hint ? el('div', { class: 'hint', text: hint }) : null);
}

function renderProfileEditor() {
  const host = $('#profile-editor');
  if (!host) return;
  const d = state.draft;
  const editing = Boolean(d.profile_id);

  const nameInput = el('input', { class: 'input', value: d.name, oninput: (e) => (d.name = e.target.value) });
  const endpointInput = el('input', { class: 'input', value: d.endpoint, oninput: (e) => (d.endpoint = e.target.value) });
  const modelInput = el('input', { class: 'input', value: d.model, oninput: (e) => (d.model = e.target.value) });
  const credInput = el('input', {
    class: 'input',
    type: 'password',
    placeholder: d.credential_set ? '已设置引用（不会回显）' : '粘贴凭证（只写，不会再次显示）',
    oninput: (e) => (d.credential = e.target.value),
  });

  const reasoningSel = el(
    'select',
    { class: 'select', onchange: (e) => (d.reasoning_effort = e.target.value) },
    el('option', { value: '' }, '默认'),
    ...['minimal', 'low', 'medium', 'high'].map((v) => el('option', { value: v, selected: d.reasoning_effort === v }, v)),
  );
  const maxTok = el('input', { class: 'input', type: 'number', value: d.max_output_tokens, oninput: (e) => (d.max_output_tokens = e.target.value) });
  const temp = el('input', { class: 'input', type: 'number', step: '0.1', min: '0', max: '2', value: d.temperature, oninput: (e) => (d.temperature = e.target.value) });
  const timeout = el('input', { class: 'input', type: 'number', value: d.request_timeout_ms, oninput: (e) => (d.request_timeout_ms = e.target.value) });
  const budget = el('input', { class: 'input', type: 'number', value: d.budget_tokens, oninput: (e) => (d.budget_tokens = e.target.value) });

  const resultHost = el('div', { style: 'margin-top:12px' });
  if (state.validation) resultHost.append(renderValidation(state.validation));

  const revisionHost = editing ? renderRevisionHistory(d) : el('div');

  const card = el(
    'div',
    { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: editing ? `编辑配置（当前 v${d.revision}）` : '新建配置' })),
    field('名称', nameInput),
    field('协议适配', el('input', { class: 'input', value: '本地 OpenAI 兼容适配器', readonly: true }), '首版只支持已实现的适配器'),
    field('服务地址', endpointInput, '不得内嵌用户名或密码；凭证请单独填写'),
    field('模型', modelInput, '填模型 ID'),
    field(
      '凭证',
      el(
        'div',
        { class: 'row' },
        el('div', { class: 'grow' }, credInput),
        editing && d.credential_set
          ? el('button', { class: 'btn btn-sm', onclick: () => { d.clear_credential = true; d.credential_set = false; renderProfileEditor(); } }, '移除')
          : null,
      ),
      d.clear_credential ? '保存后将移除已有凭证引用' : '凭证只存引用，永不回显；进程重启后需要重新输入',
    ),
    el(
      'details',
      {},
      el('summary', { text: '高级参数' }),
      el(
        'div',
        { style: 'margin-top:12px' },
        field('推理强度', reasoningSel),
        field('输出上限', maxTok),
        field('温度', temp),
        field('请求超时（毫秒）', timeout),
        field('任务预算（token，可空）', budget),
        field('数据边界', el('input', { class: 'input', value: '仅本机（local_only）', readonly: true }), '首版只允许仅本机；云端需先单独确认数据边界政策'),
      ),
    ),
    el(
      'div',
      { class: 'row', style: 'margin-top:14px; flex-wrap:wrap' },
      el(
        'button',
        {
          class: 'btn',
          onclick: async (e) => {
            e.target.disabled = true;
            e.target.textContent = '测试中…';
            try {
              const saved = await saveDraft(true);
              state.validation = await api.validateProfile(saved.profile_id, saved.revision);
              await loadProfile(saved.profile_id);
            } catch (err) {
              setBanner('error', `测试失败：${err.message}`);
            } finally {
              e.target.disabled = false;
              e.target.textContent = '测试连接与兼容性';
            }
          },
        },
        '测试连接与兼容性',
      ),
      el(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            try {
              await saveDraft(false);
              setBanner('info', '已保存为新 revision。');
              await renderSettings();
            } catch (err) {
              setBanner('error', `保存失败：${err.message}`);
            }
          },
        },
        '保存草稿',
      ),
      el(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            try {
              const saved = await saveDraft(false);
              // 保存并设为默认：先确保有验证结论
              let verdict = state.draft?.validation;
              if (!verdict || verdict.verdict !== 'compatible') {
                const v = await api.validateProfile(saved.profile_id, saved.revision);
                state.validation = v;
                verdict = v;
              }
              if (verdict.verdict !== 'compatible') {
                setBanner('warning', `不能激活：${verdict.note ?? '必需项未全部通过'}`, [
                  { label: '看测试结果', onClick: () => { state.validation = verdict; renderProfileEditor(); } },
                ]);
                return;
              }
              await api.activateProfile(saved.profile_id, saved.revision);
              setBanner('info', '已设为默认；下一个任务生效。');
              await renderSettings();
              await loadProfile(saved.profile_id);
            } catch (err) {
              setBanner('error', `激活失败：${err.message}`);
            }
          },
        },
        '保存并设为默认',
      ),
    ),
    resultHost,
    revisionHost,
  );

  host.replaceChildren(card);
}

async function saveDraft(forceValidate) {
  const d = state.draft;
  const payload = {
    name: d.name.trim(),
    provider: d.provider,
    endpoint: d.endpoint.trim(),
    model: d.model.trim(),
    ...(d.credential ? { credential: d.credential } : {}),
    ...(d.reasoning_effort ? { reasoning_effort: d.reasoning_effort } : {}),
    ...(d.max_output_tokens !== '' ? { max_output_tokens: Number(d.max_output_tokens) } : {}),
    ...(d.temperature !== '' ? { temperature: Number(d.temperature) } : {}),
    ...(d.request_timeout_ms !== '' ? { request_timeout_ms: Number(d.request_timeout_ms) } : {}),
    ...(d.budget_tokens !== '' ? { budget_tokens: Number(d.budget_tokens) } : {}),
    data_boundary: d.data_boundary,
  };

  let saved;
  if (d.profile_id) {
    saved = await api.updateProfile(d.profile_id, {
      ...payload,
      base_revision: d.base_revision,
      ...(d.clear_credential ? { clear_credential: true } : {}),
    });
    const latest = saved.revisions[0];
    d.revision = latest.revision;
    d.base_revision = latest.revision;
    d.credential = '';
  } else {
    saved = await api.createProfile(payload);
    d.profile_id = saved.profile.profile_id;
    d.revision = saved.profile.latest_revision;
    d.base_revision = saved.profile.latest_revision;
  }
  const latest = saved.revisions[0];
  d.credential_set = latest.credential_set;
  d.revisions = saved.revisions;
  d.validation = latest.validation;
  return { profile_id: d.profile_id, revision: d.revision };
}

function renderValidation(v) {
  const checks = v.checks ?? [];
  const verdictCls = v.verdict === 'compatible' ? 'ok' : 'err';
  const verdictLabel = v.verdict === 'compatible' ? '通过' : '未通过';
  return el(
    'div',
    { class: `notice ${v.verdict === 'compatible' ? 'info' : 'warning'}`, style: 'flex-direction:column; align-items:stretch' },
    el('div', { class: 'row' }, el('strong', { text: '测试结果：' }), pill(verdictCls, verdictLabel), el('span', { class: 'small muted', text: v.note ?? '' })),
    el(
      'div',
      { style: 'margin-top:8px' },
      ...checks.map((c) =>
        el(
          'div',
          { class: 'row small', style: 'padding:3px 0' },
          el('span', { class: `dot ${c.state === 'pass' ? 'ok' : c.state === 'fail' ? 'err' : c.state === 'warn' ? 'warn' : 'unknown'}` }),
          el('span', { style: 'min-width:110px', text: c.label + (c.required ? ' *' : '') }),
          el('span', { class: 'muted', text: c.detail ?? '' }),
          el('span', { class: 'spacer', style: 'margin-left:auto' }),
          el('span', { class: 'mono muted', text: dur(c.duration_ms) }),
        ),
      ),
    ),
  );
}

function renderRevisionHistory(d) {
  const revs = d.revisions ?? [];
  if (revs.length === 0) return el('div');
  return el(
    'details',
    { style: 'margin-top:14px' },
    el('summary', { text: `变更记录（${revs.length} 个 revision）` }),
    el(
      'div',
      { style: 'margin-top:10px' },
      ...revs.map((r) => {
        const v = r.validation;
        const vLabel = !v ? '未验证' : v.verdict === 'compatible' ? '通过' : v.verdict === 'stale' ? '已失效' : '未通过';
        const vCls = !v ? 'muted' : v.verdict === 'compatible' ? 'ok' : v.verdict === 'stale' ? 'warn' : 'err';
        const isActive = d.active && d.active_revision === r.revision;
        return el(
          'div',
          { class: 'row', style: 'padding:6px 0; border-bottom:1px solid var(--border)' },
          el('span', { class: 'mono small', style: 'min-width:36px', text: `v${r.revision}` }),
          el('span', { text: r.model }),
          isActive ? pill('ok', '当前默认') : null,
          pill(vCls, vLabel),
          el('span', { class: 'spacer', style: 'margin-left:auto' }),
          el('span', { class: 'small muted', text: localTime(r.created_at) }),
          v && v.verdict === 'compatible' && !isActive
            ? el(
                'button',
                {
                  class: 'btn btn-sm',
                  onclick: async () => {
                    try {
                      await api.activateProfile(d.profile_id, r.revision);
                      setBanner('info', `已回退到 v${r.revision}；下一个任务生效。`);
                      await loadProfile(d.profile_id);
                    } catch (e) {
                      setBanner('error', `回退失败：${e.message}`);
                    }
                  },
                },
                '回退到此版本',
              )
            : null,
        );
      }),
    ),
  );
}

// ---------------------------------------------------------------- 诊断
async function renderDiagnostics() {
  const main = $('#main');
  const health = await api.healthz().catch((e) => ({ error: e.message }));
  let robotHealth = null;
  try {
    const res = await fetch('http://127.0.0.1:8787/v1/health');
    robotHealth = await res.json();
  } catch (e) {
    robotHealth = { error: e.message };
  }

  main.replaceChildren(
    el('div', { class: 'page-head' }, el('button', { class: 'btn btn-sm', onclick: () => navigate('settings') }, '← 返回设置'), el('h1', { text: '开发与诊断' })),
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', { text: 'agentd' })),
      el('pre', { class: 'mono small', style: 'overflow:auto', text: JSON.stringify(health, null, 2) }),
    ),
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', { text: 'robotd（直连）' })),
      el('pre', { class: 'mono small', style: 'overflow:auto', text: JSON.stringify(robotHealth, null, 2) }),
    ),
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', { text: '连接' })),
      el(
        'dl',
        { class: 'kv' },
        el('dt', { text: '实时事件' }),
        el('dd', { text: wsStatusLabel() }),
        el('dt', { text: '待处理新事件' }),
        el('dd', { text: String(state.pendingNew) }),
      ),
    ),
  );
}

function wsStatusLabel() {
  return {
    connecting: '连接中',
    connected: '已连接',
    subscribed: '已订阅',
    reconnecting: '重连中（重连前不恢复「正常」）',
    error: '连接出错',
  }[state.wsStatus] ?? state.wsStatus;
}

// ---------------------------------------------------------------- WS 与顶部
function setWsStatus(s) {
  state.wsStatus = s;
  const host = $('#conn-status');
  if (!host) return;
  const cls = s === 'subscribed' || s === 'connected' ? 'ok' : s === 'connecting' || s === 'reconnecting' ? 'warn' : 'err';
  host.replaceChildren(el('span', { class: `dot ${cls}` }), ' ', s === 'subscribed' ? '实时更新已连接' : s === 'reconnecting' ? '断线，重连中' : s === 'error' ? '实时更新出错' : '连接中');
}

function startLive() {
  state.live?.close();
  state.live = listenEvents({
    onStatus: setWsStatus,
    onEvent: (ev) => {
      if (state.route === 'events') {
        if (state.eventsPaused) return;
        if (state.pendingNew === 0) {
          // 先提示「有 N 条新事件」，不顶走正在读的历史
          state.pendingNew = 1;
          const host = $('#new-events-host');
          if (host) {
            host.replaceChildren(
              el(
                'div',
                { class: 'new-banner' },
                el(
                  'button',
                  {
                    class: 'btn primary btn-sm',
                    onclick: async () => {
                      state.pendingNew = 0;
                      await renderEvents();
                    },
                  },
                  '有 1 条新事件，点击刷新',
                ),
              ),
            );
          }
        } else {
          state.pendingNew += 1;
          const btn = $('#new-events-host button');
          if (btn) btn.textContent = `有 ${state.pendingNew} 条新事件，点击刷新`;
        }
      } else if (state.route === 'overview') {
        // 总览让轮询负责，避免与输入框抢焦点
      }
    },
    onResync: async (msg) => {
      // 必须重拉全量，不能悄悄跳过缺口
      setBanner('warning', `实时事件需要重新同步（${resyncReason(msg.reason)}）。正在重新加载…`);
      state.eventsCursor = null;
      try {
        if (state.route === 'events') await renderEvents();
        else if (state.route === 'overview') await renderOverview();
      } catch {
        /* 忽略 */
      }
    },
  });
}

function resyncReason(reason) {
  return {
    instance_changed: 'agentd 重启过',
    cursor_expired: '游标早于保留窗口',
    invalid_cursor: '游标不合法',
  }[reason] ?? reason;
}

// ---------------------------------------------------------------- 停止机器人（全局固定）
function renderStopBar() {
  const status = el('span', { class: 'note', text: '停止直达 robotd，不经过 agentd，也不等模型。' });
  const btn = el(
    'button',
    {
      class: 'btn danger',
      onclick: async () => {
        btn.disabled = true;
        status.textContent = '正在请求停止…';
        const res = await stopBodyDirect();
        // 同时让 agentd 取消编排（失败也无所谓，停止已经直达过了）
        api.stop().catch(() => {});
        if (res.state === 'confirmed') {
          setBanner('info', `已确认停稳：${res.detail}`);
        } else if (res.state === 'requested') {
          setBanner('warning', `已请求停止，但未确认停稳：${res.detail}。请查看机器人实际状态。`);
        } else {
          setBanner('error', `停止结果未知：${res.detail}。不要假定它已经停了。`);
        }
        status.textContent = res.detail;
        btn.disabled = false;
      },
    },
    '停止机器人',
  );
  return el('div', { class: 'stop-bar' }, btn, status);
}

// ---------------------------------------------------------------- 启动
async function boot() {
  try {
    await initSession();
  } catch (e) {
    document.getElementById('banner').append(
      el('div', { class: 'notice error', text: `无法初始化会话：${e.message}` }),
    );
  }
  window.addEventListener('hashchange', onRouteChange);
  setWsStatus('connecting');
  startLive();
  renderStopBar && document.getElementById('stop-host').append(renderStopBar());
  if (!location.hash) location.hash = '#/overview';
  await onRouteChange();
  setWsStatus('connecting');
}

boot();
