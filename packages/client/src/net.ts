import type { ClientMsg, ServerMsg } from '@msimcity/shared';

type Handler<T extends ServerMsg['t']> = (m: Extract<ServerMsg, { t: T }>) => void;

/**
 * One connection to a game, whatever carries it (docs/local-mode.md section 2): a WebSocket to a server, or a local-mode
 * worker's MessagePort. Frames are JSON strings either way.
 */
export interface ClientSocket {
  readonly open: boolean;
  /** reconnect after a drop (a server restarting); a worker never drops, so a closed WorkerSocket stays closed */
  readonly retry: boolean;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
}

/** A WebSocket to a Civitas server. */
export class WsSocket implements ClientSocket {
  readonly retry = true;
  private ws: WebSocket;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string) {
    const ws = this.ws = new WebSocket(url);
    ws.onopen = () => this.onopen?.();
    ws.onmessage = (ev) => this.onmessage?.(ev.data);
    ws.onclose = () => this.onclose?.();
    ws.onerror = () => ws.close();
  }
  get open() { return this.ws.readyState === WebSocket.OPEN; }
  send(data: string) { this.ws.send(data); }
  close() { this.ws.close(); }
}

/**
 * A connection to the game in a local-mode worker (server/src/transport.ts PortSource): posts `{ctl:'connect'}` and is
 * open once the worker answers `{ctl:'ready'}`. Game frames are strings; other `{ctl}` objects are the worker host's.
 */
export class WorkerSocket implements ClientSocket {
  readonly retry = false;
  private isOpen = false;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: (() => void) | null = null;
  /** control messages from the worker host other than ready/close (saves, errors; a later phase) */
  oncontrol: ((m: { ctl: string; [k: string]: unknown }) => void) | null = null;
  constructor(private port: Worker | MessagePort) {
    port.addEventListener('message', this.listener as EventListener);
    if ('start' in port) port.start();
    port.postMessage({ ctl: 'connect' });
  }
  private listener = (ev: MessageEvent) => {
    const d = ev.data;
    if (typeof d === 'string') { if (this.isOpen) this.onmessage?.(d); return; }
    if (!d || typeof d.ctl !== 'string') return;
    if (d.ctl === 'ready') { if (!this.isOpen) { this.isOpen = true; this.onopen?.(); } }
    else if (d.ctl === 'close') this.ended();
    else this.oncontrol?.(d);
  };
  private ended() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.port.removeEventListener('message', this.listener as EventListener);
    this.onclose?.();
  }
  get open() { return this.isOpen; }
  send(data: string) { if (this.isOpen) this.port.postMessage(data); }
  close() { if (this.isOpen) { this.port.postMessage({ ctl: 'close' }); this.ended(); } }
}

/** Typed game connection with automatic reconnect (for sockets that retry). */
export class NetClient {
  private sock: ClientSocket | null = null;
  private handlers = new Map<string, (m: any) => void>();
  private name = '';
  /** the sign-in session token for each hello (auth.ts, docs/accounts.md), read afresh on every (re)connect; none on a server without sign-in */
  private token: (() => string | undefined) | null = null;
  private closedByUs = false;
  private factory: () => ClientSocket;
  private wsUrl = '';
  onStatus: (connected: boolean) => void = () => {};
  /** what this client has received, for the perf readout (render/perfhud.ts): characters of JSON (about bytes), messages, moving agents,
   *  and what handling them cost on the main thread: JSON.parse (decodeMs) and the handlers (handlerMs, by message type in byType) */
  rx = { bytes: 0, msgs: 0, agents: 0, decodeMs: 0, handlerMs: 0, byType: new Map<string, number>() };
  /** the last 2048 messages: when each was handled (performance.now), how long it took (parse and handler) and its type; for the frame trace */
  readonly log = { at: new Float64Array(2048), ms: new Float32Array(2048), type: new Array<string>(2048).fill(''), n: 0 };
  /** when the last stats messages arrived (performance.now), newest last: a gap over the server's second says its ticks were late */
  statsAt: number[] = [];
  private taps: ((m: ServerMsg) => void)[] = [];

  /** a server's WebSocket URL, or a factory for any other transport (WorkerSocket in local mode) */
  constructor(to: string | (() => ClientSocket)) {
    if (typeof to === 'string') this.url = to; else this.factory = to;
    this.factory ??= () => new WsSocket(this.wsUrl);
  }
  /** the server's WebSocket URL; setting it switches to that server on the next connect */
  get url() { return this.wsUrl; }
  set url(u: string) { this.wsUrl = u; this.factory = () => new WsSocket(u); }

  /** Look at every incoming message without taking over its handler. */
  tap(fn: (m: ServerMsg) => void) { this.taps.push(fn); }

  connect(name: string, token?: () => string | undefined) {
    this.name = name;
    this.token = token ?? null;
    this.closedByUs = false;
    this.open();
  }
  private open() {
    const sock = this.factory();
    this.sock = sock;
    sock.onopen = () => { this.onStatus(true); this.sendHello(); };
    sock.onmessage = (data) => {
      const t0 = performance.now();
      const m = JSON.parse(data) as ServerMsg;
      const t1 = performance.now();
      const rx = this.rx;
      rx.bytes += data.length; rx.msgs++; rx.decodeMs += t1 - t0;
      if (m.t === 'citizens') rx.agents += m.c.length >> 2; // quads of id, x, y, flags
      else if (m.t === 'stats') { this.statsAt.push(t1); if (this.statsAt.length > 120) this.statsAt.shift(); }
      for (const fn of this.taps) fn(m);
      this.handlers.get(m.t)?.(m);
      const t2 = performance.now(), ms = t2 - t1;
      rx.handlerMs += ms; rx.byType.set(m.t, (rx.byType.get(m.t) ?? 0) + ms);
      const l = this.log, i = l.n++ & 2047;
      l.at[i] = t0; l.ms[i] = t2 - t0; l.type[i] = m.t;
    };
    sock.onclose = () => {
      this.onStatus(false);
      if (!this.closedByUs && sock.retry) setTimeout(() => this.open(), 1500);
    };
  }
  /** Say hello again on the open socket under another name (sign-in: a new account's mayor name, after an `auth` message asked). */
  hello(name: string) { this.name = name; this.sendHello(); }
  private sendHello() {
    const token = this.token?.();
    this.send({ t: 'hello', name: this.name, ...(token ? { token } : {}) });
  }
  send(m: ClientMsg) {
    if (this.sock?.open) this.sock.send(JSON.stringify(m));
  }
  on<T extends ServerMsg['t']>(t: T, fn: Handler<T>) { this.handlers.set(t, fn); }
  get connected() { return !!this.sock?.open; }
}
