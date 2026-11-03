/**
 * agentd HTTP 层：路由、安全边界、统一错误体。
 *
 * ## 为什么自己写而不用框架
 *
 * 需求里有几条**不可能靠「默认配置」满足**的硬约束：
 *
 * 1. **只监听回环**。配置层直接拒绝 0.0.0.0，并在 bind 之后再确认一次实际地址。
 * 2. **没有通配 CORS**。不写 `Access-Control-Allow-Origin: *`，跨源写入一律拒绝。
 * 3. **Host 与 Origin 双重校验**。DNS rebinding 会带着合法 Origin 打 127.0.0.1，
 *    所以两者都要核对；只校验 Origin 是不够的。
 * 4. **CSRF 令牌**。写操作必须带 `X-Agentd-CSRF`，令牌只能由同源 GET 拿到。
 * 5. **请求体上限**。读满即断，不把超限内容攒进内存。
 * 6. **统一错误体**。`{ ok:false, error:{ code, message, details?, hint? } }`，
 *    code 稳定，调用方按 code 分支。
 *
 * ## 幂等
 *
 * `POST /api/run` 带 `idempotency_key`。键存在 meta 表里映射到 run_id，
 * 重复提交返回同一条 run（`duplicate: true`），不产生第二个任务。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const MAX_BODY_BYTES = 256 * 1024;

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** 稳定错误码 → HTTP 状态。契约 `x-agentd-errors` 是这份表的镜像。 */
export const ERROR_STATUS: Record<string, number> = {
  E_VALIDATION: 400,
  E_AUTH: 401,
  E_CSRF: 403,
  E_ORIGIN: 403,
  E_NOT_FOUND: 404,
  E_BUSY: 409,
  E_CONFLICT: 409,
  E_CURSOR_EXPIRED: 410,
  E_UNAVAILABLE: 503,
  E_STORE: 503,
  E_INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | null;
  readonly hint: string | null;

  constructor(
    code: string,
    message: string,
    opts: { details?: Record<string, unknown>; hint?: string; status?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = opts.status ?? ERROR_STATUS[code] ?? 500;
    this.details = opts.details ?? null;
    this.hint = opts.hint ?? null;
  }

  toBody(): Record<string, unknown> {
    const error: Record<string, unknown> = { code: this.code, message: this.message };
    if (this.details) error.details = this.details;
    if (this.hint) error.hint = this.hint;
    return { ok: false, error };
  }
}

// ------------------------------------------------------------------ 请求校验工具
export function requireString(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number } = {},
): string {
  if (typeof value !== 'string') {
    throw new ApiError('E_VALIDATION', `${field} 必须是字符串`, { details: { field } });
  }
  const trimmed = value;
  if (opts.min !== undefined && trimmed.length < opts.min) {
    throw new ApiError('E_VALIDATION', `${field} 长度不足 ${opts.min}`, { details: { field } });
  }
  if (opts.max !== undefined && trimmed.length > opts.max) {
    throw new ApiError('E_VALIDATION', `${field} 超过 ${opts.max} 字符`, { details: { field } });
  }
  return trimmed;
}

export function optionalInt(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ApiError('E_VALIDATION', `${field} 必须是整数`, { details: { field } });
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new ApiError('E_VALIDATION', `${field} 不得小于 ${opts.min}`, { details: { field } });
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new ApiError('E_VALIDATION', `${field} 不得大于 ${opts.max}`, { details: { field } });
  }
  return value;
}

export function optionalNumber(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError('E_VALIDATION', `${field} 必须是有限数字`, { details: { field } });
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new ApiError('E_VALIDATION', `${field} 不得小于 ${opts.min}`, { details: { field } });
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new ApiError('E_VALIDATION', `${field} 不得大于 ${opts.max}`, { details: { field } });
  }
  return value;
}

export function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ApiError('E_VALIDATION', `${field} 只能是 ${allowed.join(' / ')}`, {
      details: { field, allowed },
    });
  }
  return value as T;
}

/** 契约里写了 `additionalProperties: false` 的地方，这里必须真的拒绝未知字段。 */
export function rejectUnknown(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new ApiError('E_VALIDATION', `未声明的字段：${unknown.join(', ')}`, {
      details: { unknown, allowed },
    });
  }
}

export function parseLimit(raw: string | null, fallback = 50): number {
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new ApiError('E_VALIDATION', 'limit 必须是 1-200 的整数', { details: { limit: raw } });
  }
  return n;
}

// ------------------------------------------------------------------ 路由
export interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  /** 是否来自同源（CI 之外的浏览器请求必须为 true 才能写）。 */
  sameOrigin: boolean;
}

export type Handler = (ctx: RouteContext) => Promise<unknown> | unknown;

export interface Route {
  method: string;
  /** `/api/runs/{run_id}/cancel` */
  template: string;
  /** 契约里的 operationId，便于日志与契约核对 */
  operationId: string;
  /** 是否需要 CSRF 校验（所有写操作都要） */
  write: boolean;
  /** 是否允许跨源读（本服务一律 false：UI 同源托管） */
  corsRead?: boolean;
  handler: Handler;
  regex: RegExp;
  paramNames: string[];
}

export function compileRoute(
  method: string,
  template: string,
  operationId: string,
  write: boolean,
  handler: Handler,
): Route {
  const paramNames: string[] = [];
  const pattern = template.replace(/\{([a-zA-Z_]+)\}/g, (_m, name: string) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return {
    method,
    template,
    operationId,
    write,
    handler,
    regex: new RegExp(`^${pattern}$`),
    paramNames,
  };
}

export interface RouterConfig {
  /** 允许的 Origin 列表，例如 ['http://127.0.0.1:8791'] */
  allowedOrigins: Set<string>;
  /** 启动时生成的 CSRF 令牌 */
  csrfToken: string;
  /**
   * 本服务**实际绑定**的端口，用于 Host 校验。
   *
   * 注意这里只校验端口，不校验完整 authority：配置端口与实际上报端口必须一致才有意义，
   * 而端口 0（系统分配）时配置值没有信息量。`null` 表示跳过端口比对（仅测试用）。
   */
  selfPort: number | null;
  bootId: string;
  /** 静态资源根（托管 UI）；null 表示不托管 */
  staticDir: string | null;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export class Router {
  private routes: Route[] = [];
  readonly config: RouterConfig;

  constructor(config: RouterConfig) {
    this.config = config;
  }

  add(route: Route): void {
    this.routes.push(route);
  }

  /**
   * 已登记路由的只读快照。
   *
   * 存在的唯一理由是让 `tests/contract/` 能断言「实现注册的路由 == 契约声明的路由」。
   * 契约漂移最典型的形态就是「代码里加了端点、契约没加」或反之——
   * `contract:check` 只保证「生成物 == 契约」，管不到实现，这里补上另一半。
   * 返回拷贝，调用方改它不会影响真实路由表。
   */
  listRoutes(): readonly Route[] {
    return [...this.routes];
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1]);
      });
      return { route, params };
    }
    return null;
  }

  /** 对同一路径是否存在其他方法（用于 405 与 Allow 头）。 */
  allowedMethods(pathname: string): string[] {
    return this.routes
      .filter((r) => r.regex.test(pathname))
      .map((r) => r.method)
      .filter((m, i, arr) => arr.indexOf(m) === i);
  }

  get operationIds(): string[] {
    return this.routes.map((r) => r.operationId);
  }
}

// ------------------------------------------------------------------ 安全校验
function headerOne(req: http.IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === 'string' ? v : null;
}

/**
 * Host 校验：防 DNS rebinding。
 *
 * 攻击者把 evil.com 解析到 127.0.0.1，浏览器仍会带上 `Host: evil.com`。
 * 所以「监听回环」本身**不够**，必须核对 Host 头。
 *
 * 主机名必须是回环；端口（若已知）必须等于**实际绑定**的端口——
 * 同机另一个端口的页面不算同源。
 */
export function checkHost(req: http.IncomingMessage, selfPort: number | null): void {
  const host = headerOne(req, 'host');
  if (!host) {
    throw new ApiError('E_ORIGIN', '缺少 Host 头');
  }
  // IPv6 字面量形如 [::1]:8791
  const m = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(host);
  const hostname = (m?.[1] ?? host).toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new ApiError('E_ORIGIN', `Host 不是回环地址（${hostname}）；本服务只接受本机访问`);
  }
  if (selfPort !== null) {
    const port = m?.[2] ? Number(m[2]) : 80;
    if (port !== selfPort) {
      throw new ApiError('E_ORIGIN', `Host 端口不匹配（${port} ≠ ${selfPort}）`);
    }
  }
}

/**
 * Origin 校验：只放行同源。
 *
 * 没有 Origin 头的请求分两类：
 * - 非浏览器客户端（curl、脚本、测试）：允许读，写操作靠 CSRF 令牌保护；
 * - 某些浏览器场景（同源 GET 可能不带 Origin）：允许。
 * 因此**写操作的真正门禁是 CSRF 令牌**，Origin 是纵深防御。
 */
export function checkOrigin(
  req: http.IncomingMessage,
  allowedOrigins: Set<string>,
): { sameOrigin: boolean } {
  const origin = headerOne(req, 'origin');
  if (!origin) {
    // 无 Origin：不是跨源浏览器请求。是否可信由 CSRF 令牌决定。
    return { sameOrigin: true };
  }
  if (!allowedOrigins.has(origin)) {
    throw new ApiError('E_ORIGIN', `Origin 不在允许列表（${origin}）`, {
      hint: 'UI 由 agentd 同源托管；不要把别的页面指过来',
    });
  }
  return { sameOrigin: true };
}

export function checkCsrf(req: http.IncomingMessage, expected: string): void {
  const got = headerOne(req, 'x-agentd-csrf');
  if (!got) {
    throw new ApiError('E_CSRF', '缺少 X-Agentd-CSRF 头', {
      hint: '先 GET /api/session 取 csrf，再在写请求里回传',
    });
  }
  // 定时安全比较：避免用响应时间猜令牌
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ApiError('E_CSRF', 'CSRF 令牌不匹配');
  }
}

// ------------------------------------------------------------------ 请求体
export function readBody(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const fail = (err: ApiError): void => {
      if (done) return;
      done = true;
      chunks.length = 0;
      // 不 destroy：先让调用方把 400 写出去，再关连接。
      // destroy 会让客户端看到 ECONNRESET，分不清「太大」和「服务挂了」。
      // 内容已经被丢弃，不会攒进内存；剩余字节由调用方 stop() 掉。
      req.pause();
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(
          new ApiError('E_VALIDATION', `请求体超过 ${maxBytes} 字节上限`, {
            details: { max_bytes: maxBytes, received: total },
          }),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(new ApiError('E_VALIDATION', `读取请求体失败：${err.message}`));
    });
  });
}

/**
 * 在超限请求上收尾：先回 400，再半关连接。
 *
 * 直接用 `Connection: close` 而不 destroy，客户端能正常读到 400 错误体。
 */
export function abortOversized(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  err: ApiError,
  log: (msg: string, extra?: Record<string, unknown>) => void,
): void {
  const payload = Buffer.from(JSON.stringify(err.toBody()), 'utf8');
  res.writeHead(err.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    connection: 'close',
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(payload, () => {
    log('rejected oversized body', { max_bytes: MAX_BODY_BYTES });
    req.destroy();
  });
}

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  // UI 只用内联样式与模块脚本，禁止外部资源，便于离线
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(payload);
}

/** 回环访问不带 CORS 头：UI 同源托管，跨源方什么都不该拿到。 */
export function sendNoCors(res: http.ServerResponse): void {
  res.setHeader('vary', 'Origin');
}

export function serveStatic(
  res: http.ServerResponse,
  staticDir: string,
  pathname: string,
  log: (msg: string, extra?: Record<string, unknown>) => void,
): boolean {
  let rel = pathname === '/' ? '/index.html' : pathname;
  // 目录穿越防护：规范化后必须仍在 staticDir 内
  const target = path.resolve(staticDir, `.${rel}`);
  const rootWithSep = path.resolve(staticDir) + path.sep;
  if (!target.startsWith(rootWithSep) && target !== path.resolve(staticDir)) {
    throw new ApiError('E_NOT_FOUND', '资源不存在');
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    // SPA 回退：未知路径交给前端路由，但只对无扩展名的路径生效
    if (!path.extname(rel)) {
      const index = path.join(staticDir, 'index.html');
      if (fs.existsSync(index)) return serveStatic(res, staticDir, '/index.html', log);
    }
    return false;
  }
  const ext = path.extname(target).toLowerCase();
  const buf = fs.readFileSync(target);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': String(buf.length),
    // 本地单机应用：一律不缓存。服务随代码一起重启，缓存只会让人看到旧样式/旧脚本，
    // 排错时误以为改动没生效。
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(buf);
  log('static served', { path: rel, bytes: buf.length });
  return true;
}

/** 判断路径是否属于 API 面（API 不接受 SPA 回退）。 */
export function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname === '/healthz';
}

/**
 * 把任意抛出物收敛成 ApiError。
 *
 * store 层的 `StoreUnavailable`（以及 robotd 客户端的 `RobotdCallError`）
 * 故意不依赖 HTTP 层——它们属于领域。所以转换放在这里统一做，
 * 免得每个 handler 都写 try/catch 然后再漏一个。
 */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const anyErr = e as any;
  // StoreUnavailable：磁盘/权限问题 → fail-closed，副作用一律不落
  if (anyErr?.name === 'StoreUnavailable' || anyErr?.code === 'E_STORE') {
    return new ApiError('E_STORE', anyErr.message ?? '历史库不可写', {
      hint: '检查磁盘空间与数据目录权限；停止机器人不受影响',
    });
  }
  // RobotdCallError：把对端错误码映射成本层的依赖不可用语义
  if (anyErr?.name === 'RobotdCallError') {
    const code = anyErr.code === 'E_UNREACHABLE' || anyErr.code === 'E_TIMEOUT' ? 'E_UNAVAILABLE' : 'E_UNAVAILABLE';
    return new ApiError(code, `robotd：${anyErr.message}`, {
      details: { robotd_code: anyErr.code, http_status: anyErr.httpStatus ?? null },
    });
  }
  // 事件登记表写入失败是开发期错误：写进稳定接口必须是 500，且要说清楚
  if (anyErr?.name === 'EventRegistryError') {
    return new ApiError('E_INTERNAL', `事件登记表拒绝写入：${anyErr.message}`);
  }
  const message = typeof anyErr?.message === 'string' ? anyErr.message : String(e);
  return new ApiError('E_INTERNAL', message);
}

export { HERE };
