import type { AuthConfig } from '@msimcity/shared';
import { apiBase } from './serverApi';

/**
 * Sign-in on the join card (docs/accounts.md). Only a server whose `/api/config` has `auth` asks for it, and only for its live world:
 * demos, test cities, `?ws=` servers and local mode never load this path.
 *
 * Two providers, one flow:
 *  - `hanko`: Hanko's <hanko-auth> element (passkey, passcode by email, whatever the tenant allows). The elements are a dynamic
 *    import, so they stay out of every other page's first load.
 *  - `dev`: the server's built-in test sign-in for dev and UAT (DEV_AUTH_USERS): a user and password posted to /api/auth/dev for a
 *    token, kept in this browser's localStorage.
 * Either way a session token goes in every hello (net.ts), and the server says through an `auth` message whether it also needs a
 * mayor name (a new account) or a fresh sign-in (the token expired).
 */
type Hanko = Awaited<ReturnType<typeof import('@teamhanko/hanko-elements')['register']>>['hanko'];
const DEV_TOKEN = 'msimcity.devToken';

export class SignIn {
  private hanko: Hanko | null = null;
  private box: HTMLDivElement;
  private note: HTMLParagraphElement;
  private out: HTMLButtonElement;

  constructor(private cfg: AuthConfig, private form: HTMLElement) {
    this.box = document.createElement('div');
    this.box.id = 'signIn';
    this.box.hidden = true;
    this.note = document.createElement('p');
    this.note.id = 'signInNote';
    this.note.hidden = true;
    this.out = document.createElement('button');
    this.out.type = 'button';
    this.out.id = 'signOut';
    this.out.textContent = 'Sign out';
    this.out.hidden = true;
    this.out.onclick = () => void this.signOut();
    const input = form.querySelector('#nameInput');
    form.insertBefore(this.note, input);
    form.insertBefore(this.box, input);
    form.append(this.out);
  }

  /** The session token the next hello carries ('' when signed out). */
  token = (): string => {
    if (this.cfg.provider === 'dev') return devToken() ?? '';
    try { return this.hanko?.getSessionToken() ?? ''; } catch { return ''; }
  };

  /**
   * Resolves once this browser has a session: at once when it already has one, else after the sign-in step. `msg` (the server
   * refused the token) drops the session first and says why.
   */
  async signIn(msg?: string): Promise<void> {
    this.showLogin();
    this.mode('signIn', msg);
    if (this.cfg.provider === 'dev') {
      if (msg) store(DEV_TOKEN, null);
      else if (devToken()) return this.signedIn();
      await this.devForm();
      return this.signedIn();
    }
    const { register } = await import('@teamhanko/hanko-elements');
    this.hanko ??= (await register(this.cfg.apiUrl, { shadow: true })).hanko;
    const hanko = this.hanko;
    if (!msg) { // an expired or refused token asks again even when Hanko still thinks the session is fine
      try { if ((await hanko.validateSession()).is_valid) return this.signedIn(); } catch { /* not signed in: the element below */ }
    } else await hanko.logout().catch(() => {});
    if (!this.box.firstChild) this.box.append(document.createElement('hanko-auth'));
    this.box.hidden = false;
    await new Promise<void>((resolve) => { hanko.onSessionCreated(() => resolve(), true); });
    this.signedIn();
  }

  /** A new account (or a name that cannot be had): the name field and the join button, under the server's reason. */
  askName(msg?: string) {
    this.showLogin();
    this.mode('name', msg ?? 'Signed in. Choose your mayor name: other players will see it, and it stays yours.');
  }

  async signOut() {
    if (this.cfg.provider === 'dev') store(DEV_TOKEN, null);
    else await this.hanko?.logout().catch(() => {});
    location.reload();
  }

  /** The dev sign-in: a user and a password for POST /api/auth/dev (inputs, not a form: it sits inside the join form). */
  private devForm(): Promise<void> {
    this.box.replaceChildren();
    const user = el('input', { id: 'devUser', placeholder: 'Test user', autocomplete: 'username' });
    const pass = el('input', { id: 'devPass', placeholder: 'Password', type: 'password', autocomplete: 'current-password' });
    const go = el('button', { type: 'button', textContent: 'Sign in (test)' });
    const tag = el('p', { className: 'devAuthTag', textContent: 'Test sign-in for dev and UAT servers.' });
    this.box.append(tag, user, pass, go);
    this.box.hidden = false;
    user.focus();
    return new Promise((resolve) => {
      const submit = async () => {
        if (!user.value.trim()) return user.focus();
        go.disabled = true;
        try {
          const r = await fetch(`${apiBase()}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: user.value, password: pass.value }) });
          const j = (await r.json().catch(() => ({}))) as { token?: string; exp?: number; error?: string };
          if (!r.ok || !j.token) { this.say(j.error ?? 'Sign-in failed'); pass.select(); return; }
          store(DEV_TOKEN, JSON.stringify({ token: j.token, exp: j.exp ?? 0 }));
          this.say();
          resolve();
        } catch { this.say('The server did not answer'); } finally { go.disabled = false; }
      };
      go.onclick = () => void submit();
      for (const i of [user, pass]) i.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } };
    });
  }

  private signedIn() { this.box.hidden = true; this.out.hidden = false; }

  private showLogin() { document.getElementById('login')?.classList.remove('hidden'); }

  private say(msg?: string) { this.note.hidden = !msg; this.note.textContent = msg ?? ''; }

  /** what the card shows: the sign-in while signing in; the name field and the join button once signed in */
  private mode(step: 'signIn' | 'name', msg?: string) {
    for (const e of this.form.querySelectorAll<HTMLElement>('#nameInput, button[type=submit]')) e.style.display = step === 'name' ? '' : 'none';
    this.box.hidden = step !== 'signIn';
    this.say(msg);
    if (step === 'name') {
      const b = this.form.querySelector<HTMLButtonElement>('button[type=submit]');
      if (b) { b.disabled = false; b.textContent = 'Join world'; }
      this.form.querySelector<HTMLInputElement>('#nameInput')?.focus();
    }
  }
}

/** the stored dev token while it has not expired */
function devToken(): string | null {
  try {
    const j = JSON.parse(localStorage.getItem(DEV_TOKEN) ?? 'null') as { token?: string; exp?: number } | null;
    return j?.token && (j.exp ?? 0) > Date.now() ? j.token : null;
  } catch { return null; }
}
function store(k: string, v: string | null) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window: signed in for this page only */ } }
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]>): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}
