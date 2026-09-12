# VLESS Panel

A local, single-page panel that deploys a personal [VLESS](https://xtls.github.io/development/protocols/vless.html)-over-WebSocket VPN to your own Cloudflare Workers account — with a few clicks, no CLI, and no third party ever touching your Cloudflare API token.

## Why this exists

Most "free VPN on Cloudflare Workers" projects on GitHub either require you to hand your Cloudflare API token to a third-party bot/panel to deploy for you, or require running `wrangler` from a terminal by hand. This project does neither:

- It's a plain HTML/CSS/TypeScript page (no framework) that runs entirely on your own machine.
- It talks to the Cloudflare API directly from your browser. Your token never leaves your computer except to go straight to `api.cloudflare.com`.
- You can read every line of the code that touches your token — there is no hidden backend.

## How it works

The project has two parts:

**1. The Worker (`worker/worker.js`)**
This is the actual Cloudflare Worker that gets deployed to your account. It implements a minimal VLESS-over-WebSocket-over-TLS relay using the `cloudflare:sockets` API:

- Parses and authenticates VLESS requests against a UUID you generate.
- Opens outbound TCP connections to whatever destination the VLESS client asks for.
- Handles DNS (UDP port 53) by forwarding queries to Cloudflare's own DNS-over-HTTPS resolver, so DNS never leaks to your ISP.
- Supports an optional `PROXYIP` fallback for destinations that are themselves hosted on Cloudflare (see "Known limitations" below) — not configured by default.

**2. The panel (this page)**
`index.html` + `src/*.ts` (compiled to `dist/*.js`) is the UI. It calls the Cloudflare REST API to upload the Worker above, set your UUID as an encrypted secret, enable the `workers.dev` route, and read your daily request usage.

Cloudflare's API doesn't support cross-origin (CORS) requests from a browser page, so a small, framework-free Node script (`server.js`) does two things: serves this page locally, and transparently relays your browser's requests to `api.cloudflare.com`. It doesn't inspect, store, or modify anything — it's a byte-for-byte relay you can read in a couple of minutes.

## Requirements

- [Node.js](https://nodejs.org) (any current LTS version)
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- A VLESS-capable client on the device you want to use the VPN from, e.g. [v2rayN](https://github.com/2dust/v2rayN) or [NekoBox](https://github.com/MatsuriDayo/NekoBoxForAndroid) on Windows, [v2rayNG](https://github.com/2dust/v2rayNG) on Android

## Setup

1. Download or clone this repository and extract it somewhere.
2. Open a terminal in the project folder and run:
   ```
   npm install
   npm run build
   npm start
   ```
3. Open `http://localhost:5173` in your browser.

## Creating a Cloudflare API token

The panel needs a token scoped to only what it uses — nothing more.

1. In the Cloudflare dashboard, use the search box at the top and search for **API Tokens**. Open it (this goes to `dash.cloudflare.com/profile/api-tokens`).
2. Click **Create Token** → **Custom token**.
3. Add exactly two permissions:
   - `Account` / `Workers Scripts` / **Edit**
   - `Account` / `Account Analytics` / **Read**
4. Under **Account Resources**, choose **Include** → your account.
5. Continue to summary → **Create Token**.
6. **Copy the token now and save it somewhere.** Cloudflare only shows it once.

Common mistake: selecting **Read** instead of **Edit** for Workers Scripts. This doesn't show up as a permissions error — Cloudflare returns a generic "Authentication error" instead. Use the panel's **Verify token** button first to confirm the token itself is valid before troubleshooting further.

## Finding your Account ID

In the dashboard sidebar, go to **Build → Compute → Workers & Pages** (Build is just a section label, not a link). A panel on the right shows your **Account ID** and your `workers.dev` subdomain — the subdomain is already provisioned automatically; there's nothing to set up there.

## Deploying

1. Paste your token and Account ID into the panel.
2. Optionally click **Verify token** to confirm it works.
3. Click **Deploy**. This generates a new UUID, uploads the Worker, enables the `workers.dev` route, and shows you a ready-to-use `vless://` link.
4. Click **Copy link**, then import it into your VLESS client.
   - Recommended client settings: disable Mux, enable TUN mode for full-device tunneling.
5. Use **Today's usage** any time to see how much of Cloudflare's free 100,000-requests/day limit you've used.

Re-running **Deploy** generates a brand-new UUID and replaces the previous one — any client still using the old `vless://` link will stop working.

## Known limitations

- **Cloudflare-hosted destinations don't work by default.** Cloudflare Workers cannot open outbound connections to other Cloudflare-hosted IP addresses. Sites like claude.ai or chatgpt.com are themselves behind Cloudflare, so they won't be reachable through this tunnel unless you configure a `PROXYIP` (a relay you control, hosted outside Cloudflare) — not covered by this panel yet. Everything else (GitHub, npm, most APIs, direct database connections, etc.) works normally.
- **You can't use this panel while connected to your own VPN.** For the same reason above, once your device is routing through the deployed VLESS config, it can't reach Cloudflare's own dashboard or API — so Verify/Deploy/Usage requests here will fail, and the Cloudflare dashboard itself won't load through that tunnel. Disconnect first.
- **This sits in a gray area of Cloudflare's terms of service.** Cloudflare's Self-Serve Subscription Agreement prohibits using its services to run a VPN or similar proxy service. Enforcement appears to target higher-traffic, multi-user setups rather than light personal use, but it isn't zero risk. Consider using a Cloudflare account dedicated only to this project, so a worst-case suspension doesn't affect anything else.
- **Long-lived connections can drop occasionally.** Cloudflare updates its Workers runtime a few times a week and gives active connections a short grace period before closing them. If you keep long-lived database connections open through this tunnel, make sure your client reconnects automatically (most do).
