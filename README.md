# misha-browser

Browser extension and MCP server for browser and desktop control, with Misha's Slack transport. Apache-2.0.

The repository holds:

- the wire protocol, in `src/protocol/`: how the extension, its native messaging host and relay, and the relay's clients talk to each other. It covers requests and replies, events the extension keeps in durable storage and forwards again until the app acknowledges them, signed-in identity and capture health reported apart, an allowlist of Slack Web API methods, and private file downloads and uploads in chunks under Chrome's 1 MB limit, with an upload's Slack file id known before the file is shared
- the Manifest V3 extension, in `src/extension/` and `src/service-worker/`. In a signed-in Slack tab it reads new messages from the page's own socket and makes allowlisted Web API calls, downloads and uploads with the session Slack's web client already has. The token and cookies never leave the page
- the native host and its relay, in `src/host/`, which carry requests, replies, events and acks between the extension and processes on the same Mac through a socket only the user can open
- a Node client for that socket, in `src/client/`

The MCP server isn't written yet.

Misha's app imports the protocol as `misha-browser/protocol` and the client as `misha-browser/client`. Node processes also get the framing helpers from `misha-browser/protocol/framing`.

## Loading the extension and the native host

Both run on macOS, in Chrome or Brave.

1. Build: `pnpm install && pnpm run build`. The unpacked extension lands in `dist/extension`.
2. Install the native host: `pnpm run install-host`. It writes a launcher to `~/.misha/browser-bridge/native-host` and registers the host as `misha.browser_bridge` with Chrome, Brave or both, wherever a profile folder exists, so that only this extension can start it. The launcher names the current Node binary by its absolute path, so run it again after a Node upgrade.
3. Open `brave://extensions` or `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick `dist/extension`. Its id is `lkibgdfhoikfdbkhdlnoiajfelcmohjj`, fixed by the public key in the manifest.
4. Reload any Slack tab that was already open. The extension reads Slack's socket from a script that has to run before Slack's own, so a tab opened earlier shows as signed in but not capturing until it reloads.

Once the browser has started the host, clients connect to `~/.misha/browser-bridge/bridge.sock`.

## Development

Node 24 and pnpm 11:

```sh
pnpm install
pnpm run typecheck && pnpm run lint && pnpm run format:check && pnpm test
```
