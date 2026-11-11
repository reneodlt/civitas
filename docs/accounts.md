# Accounts and sign-in

Until now the mayor name typed on the join card *was* the identity: anyone typing "Ana" became Ana. This adds sign-in to the
live world, with two interchangeable providers:

- **Hanko** ([hanko.io](https://hanko.io), Hanko Cloud or self-hosted): passkeys, passcodes by email, social logins, whatever the
  tenant allows. For UAT against a real tenant and production.
- **Dev sign-in**: a built-in user/password list from the environment, so dev and UAT servers can test the whole signed-in flow
  without a Hanko tenant. Testing only.

Both end in the same thing: a session token the page sends in its `hello`, checked by the server, whose user id is bound to one
mayor (a player id) in `accounts.json`. Everything after the token is shared code.

## Turning it on

| Variable | Meaning |
| --- | --- |
| `HANKO_API_URL` | The Hanko API URL (Hanko Cloud: `https://<project-id>.hanko.io`). Turns on Hanko sign-in. |
| `HANKO_AUDIENCE` | Optional. Checked against the token's `aud` (Hanko sets it to the app's domain). Recommended in production. |
| `DEV_AUTH_USERS` | `user:password,user:password`. Turns on the dev sign-in. Plain-text passwords: never on a public server. |
| `DEV_AUTH_SECRET` | Optional. The key signing dev tokens; without it a random key per start (every browser signs in again after a restart). |
| `ACCOUNTS_FILE` | Where the bindings live. Default `accounts.json` beside the world file (so `/data` in Docker). |
| `AUTH_CLAIM_EXISTING` | `1`: a signed-in account asking for a mayor name that exists from before sign-in takes that mayor (first come). Off: such names are refused as taken. Turn it on for one migration window, then off. |

Set one provider, not both (the server refuses to start with both). Neither set: no sign-in, the old name-only join.

Sign-in applies to the **live world** of the main server only. Demos and test cities are sandboxes and keep the name-only join,
and a `SPECTATE=1` showcase only looks, so it never asks. Local mode (`/play/`, `?local`) never loads any of this.

Examples:

```sh
# dev or UAT without Hanko
DEV_AUTH_USERS="ana:test,ben:test" npm run dev

# UAT or production with Hanko
HANKO_API_URL=https://<project-id>.hanko.io HANKO_AUDIENCE=civitas.example npm start
```

### Setting up the Hanko project

1. Create a project at [cloud.hanko.io](https://cloud.hanko.io) (or run hanko yourself, its `config.yaml` has the same settings).
2. **App URL**: the page's origin, e.g. `https://civitas.reneo.app`. For local work `http://localhost:5173`. Hanko only answers
   requests (CORS) and makes passkeys for the origin configured here, so each environment needs its own project or URL.
3. Choose the login methods (passkeys, passcodes, password, social). Nothing in Civitas depends on which.
4. Copy the project's **API URL** into `HANKO_API_URL`.
5. Session lifetime is Hanko's setting; when a token expires a reconnect asks to sign in again.

## How it works

```
page                                   server (index.ts, net.ts)                 Hanko / dev
GET /api/config ─────────────────────▶ { auth: { provider, apiUrl? } }
sign in (<hanko-auth> | dev form) ─────────────────────────────────────────────▶ session token
hello { name, token } ───────────────▶ verify(token)  (auth.ts: JWKS | HMAC)
                                       account bound?  ─ yes ─▶ welcome as its mayor (name typed ignored)
                                       │ no
                                       name given and free? ─ yes ─▶ bind (accounts.json), welcome
                       ◀─ auth {need:'name', msg} ─┘ no
                       ◀─ auth {need:'signIn', msg}   (no token, expired, forged)
```

- `packages/server/src/auth.ts`: `hankoAuth` (the token is a JWT checked against `<HANKO_API_URL>/.well-known/jwks.json` with
  [`jose`](https://github.com/panva/jose); the key set is fetched once and cached), `devAuth` (`POST /api/auth/dev` with
  `{user, password}` returns an HMAC-signed token valid 12 hours; the account id is `dev:<user>`), and the account store both
  share. Node only.
- `packages/server/src/net.ts`: `GameConfig.auth` (the `AuthHook` interface, so `net.ts` still runs in the local-mode worker),
  `signedHello`, and `enter` (the old hello body).
- `packages/shared/src/protocol.ts`: `hello.token`, the `auth` server message, `ServerConfig.auth` / `AuthConfig`.
- `packages/client/src/auth.ts`: `SignIn`, the join card's sign-in step for either provider; Hanko's elements are a dynamic import
  (their own chunk, about 47 KB gzipped).
- `packages/client/src/main.ts` `signedJoin`, `packages/client/src/net.ts` (the token read afresh on every reconnect, `hello(name)`).
- `npm run auth:check` (`packages/server/src/auth-check.ts`): the dev provider through the real `Net`: login over HTTP, no
  token, a forged and an expired token, the name step, a taken name, a returning account, the binding surviving a restart, and
  `AUTH_CLAIM_EXISTING`.

Rules that hold:

- A returning account enters as its own mayor whatever name is typed; the typed name only names a new account's mayor.
- A player id belongs to at most one account. Two spellings of one name ("Mayor Ana", "mayor ana") are the same id.
- A dev user taken off `DEV_AUTH_USERS` is signed out at their next hello.
- `World` reset (`RESET`) keeps `accounts.json`: a bound account's mayor is made afresh under the stored name.

## Still to do

Picked up from here (the audit's item 14, `docs/audit-2026-10.md`, has the wider list):

1. **A Hanko project per environment** (dev, UAT, production) with the App URL set, and `HANKO_API_URL` / `HANKO_AUDIENCE` in each
   deployment's environment (Docker run, compose or the host's secrets). Try the Hanko flow in a browser against a real
   tenant: only the dev provider has been run end to end here.
2. **Theme `<hanko-auth>`** to match the card: its CSS variables are started in `style.css` (`#signIn hanko-auth`); check it in
   both the light passkey prompt and the passcode step, and on a phone.
3. **In-game account UI**: sign out is on the join card and `msc.signOut()` only. Put it in the top bar's player chip, and
   `<hanko-profile>` (passkeys, email) in a panel.
4. **Session revocation**: tokens are checked at hello only; a socket stays in until it closes. If that matters, re-verify on a
   timer, or ask Hanko's `/sessions/validate` instead of only the JWKS, and close sockets whose session ended.
5. **The home page** (`landing.ts`): its "This server's live world" join form takes a name; with sign-in on it should say "Sign
   in to play" and link to `/?go`. Then set our entry in `packages/server/servers.json` to `open`.
6. **Migration of the existing live world**: turn on `AUTH_CLAIM_EXISTING=1` for a window so current mayors can claim their names,
   then off. Consider an admin CLI to bind or unbind an account by hand (`accounts.json` is plain JSON meanwhile).
7. **Rate limits** on `POST /api/auth/dev` (and hellos) if a dev server is reachable from the internet; better, keep dev sign-in
   behind the VPN or basic auth at the proxy.
8. **Accounts into the planned database** when the JSON snapshot is replaced (README roadmap).
