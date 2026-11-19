# misha-browser

Browser extension and MCP server for browser and desktop control, with Misha's Slack transport. Apache-2.0.

The repository holds:

- the wire protocol, in `src/protocol/`: how the extension, its native messaging host and relay, and the relay's clients talk to each other. It covers requests and replies, events the extension keeps in durable storage and forwards again until the app acknowledges them, signed-in identity and capture health reported apart, an allowlist of Slack Web API methods, and private file downloads and uploads in chunks under Chrome's 1 MB limit, with an upload's Slack file id known before the file is shared
- the Manifest V3 extension, in `src/extension/` and `src/service-worker/`. In a signed-in Slack tab it reads new messages from the page's own socket and makes allowlisted Web API calls, downloads and uploads with the session Slack's web client already has. The extension uses the session token only inside the page and never returns Slack's saved session; see Security for the network log, which receives request credentials from the browser and redacts them
- the native host and its relay, in `src/host/`, which carry requests, replies, events and acks between the extension and processes on the same Mac through a socket only the user can open
- a Node client for that socket, in `src/client/`
- the browser tools (`tab_*`, in `src/tools/`), which read and drive the user's own browser through the extension, and the desktop tools (`macos_*`, in `src/desktop/`), which move the Mac's mouse, press its keys, capture its screen, and bring apps to the front
- a standalone MCP server, in `src/mcp/`, that serves both sets of tools over stdio

Misha's app imports the protocol as `misha-browser/protocol` and the client as `misha-browser/client`. Node processes also get the framing helpers from `misha-browser/protocol/framing`. A Misha extension serves the tools through `misha-browser/modules`, which exports `browserModule` and `desktopModule`: each has a `create` that builds the module's tools and a `jsonSchema` that converts a tool's input with this package's zod, so the descriptions the model reads survive.

## The MCP server

`dist/mcp/server.js` (the package's `misha-browser-mcp` bin) serves 26 tools to any MCP client, for the folder it was started in:

- browser: `tab_list`, `tab_switch`, `tab_open`, `tab_close`, `tab_read`, `tab_find`, `tab_wait`, `tab_screenshot`, `tab_network`, `tab_click`, `tab_drag`, `tab_type`, `tab_fill`, `tab_select_option`, `tab_press`, `tab_scroll`
- desktop: `macos_mouse_move`, `macos_mouse_click`, `macos_mouse_current_position`, `macos_mouse_drag`, `macos_mouse_scroll`, `macos_keyboard_type`, `macos_keyboard_press`, `macos_screen_capture`, `macos_list_apps`, `macos_focus_app`

Each tool's description tells the model when to use it. A page reads as a compact outline (headings, visible text, and each control with a numbered ref, role, name and state) instead of HTML, and clicks, typing, key presses and scrolling are real input, so pages get the same events a person makes. After an action, the result lists what changed on the page. The tools run on macOS only; elsewhere they stay listed and each one says so when called.

Build first (`pnpm install && pnpm run build`), then register the server with the absolute path of this checkout.

Claude Code:

```sh
claude mcp add --scope user misha-browser -- node /absolute/path/to/misha-browser/dist/mcp/server.js
```

OpenCode 2, in `opencode.json`. `codemode: false` lists each tool by its own name instead of behind OpenCode's `execute` tool:

```json
{
  "mcp": {
    "servers": {
      "misha-browser": {
        "type": "local",
        "command": ["node", "/absolute/path/to/misha-browser/dist/mcp/server.js"],
        "codemode": false
      }
    }
  }
}
```

The browser tools need the extension and its native host, as below. `tab_network` lists the fetch and XHR requests a tab sent, with credentials redacted by name and pattern (see Security); it never writes a session anywhere.

### macOS permissions

The tools that move the mouse, press keys or capture the screen share one input session, which asks for two permissions when it starts: Accessibility, to post mouse and keyboard events, and Screen Recording (Screen & System Audio Recording on recent macOS), for the screen capture. Input fails without either. They are `tab_click`, `tab_drag`, `tab_type`, `tab_fill`, `tab_press`, `tab_scroll`, every `macos_mouse_*` and `macos_keyboard_*` tool, and `macos_screen_capture`. The Return that accepts a download's save dialog after a browser action goes through the same session.

Grant both to the app that runs Claude Code or OpenCode (the terminal, the editor whose terminal you use, or the desktop app) in System Settings > Privacy & Security: turn the app on in each list, or add it with + if it is missing, then quit it completely and open it again. A running app keeps failing until it restarts.

The browser tools that only read or work through the extension (`tab_list`, `tab_read`, `tab_find`, `tab_wait`, `tab_screenshot`, `tab_network`, `tab_open`, `tab_switch`, `tab_close`, `tab_select_option`), `macos_list_apps` and `macos_focus_app` need no permission. `tab_screenshot` captures through the extension, not the screen.

## Loading the extension and the native host

Both run on macOS, in Chrome or Brave.

1. Build: `pnpm install && pnpm run build`. The unpacked extension lands in `dist/extension`.
2. Install the native host: `pnpm run install-host`. It writes a launcher to `~/.misha/browser-bridge/native-host` and registers the host as `misha.browser_bridge` with Chrome, Brave or both, wherever a profile folder exists, so that only this extension can start it. The launcher names the current Node binary by its absolute path, so run it again after a Node upgrade. The installer makes `~/.misha/browser-bridge` accessible only to you (mode 700), and stops with an error when that folder or `~/.misha` is a symlink, when either belongs to another user (root may own `~/.misha`), when anyone else can write to `~/.misha`, or when an ACL on either has an entry that allows access (`ls -le` lists them, `chmod -N` removes them; entries that deny are fine).
3. Open `brave://extensions` or `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick `dist/extension`. Its id is `lkibgdfhoikfdbkhdlnoiajfelcmohjj`, fixed by the public key in the manifest. After a rebuild, reload it there. A Slack tab whose page loaded with this version's observer keeps capturing without a reload: the service worker gives the page a new relay, which takes a channel from the observer, along with any new message that came while no relay ran.
4. Reload any Slack tab that was already open when you first loaded the extension. The extension reads Slack's socket from a script that has to run before Slack's own, so a tab opened earlier shows as signed in but not capturing until it reloads. The same holds once when you upgrade from a build whose observer answers only the first relay (any build before commit `e413233`): reload the extension, then reload each open Slack tab once, since its page still runs the old observer, which gives the new relay no channel. From then on, reloading the extension needs no tab reload.

Once the browser has started the host, clients connect to `~/.misha/browser-bridge/bridge.sock`.

The extension asks the browser for these permissions, which an unpacked extension gets when it is loaded:

| Permission                     | Used for                                                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nativeMessaging`              | The connection to the native host                                                                                                                                                                   |
| `scripting`, `tabs`, all sites | Running the Slack commands in a Slack tab, giving open Slack tabs a new relay after the extension reloads, listing tabs, and running the outline and page commands of the browser tools in any page |
| `webRequest`                   | Following the fetch and XHR requests a browser action started, to wait for them, and recording them for `tab_network`; it never blocks or changes one                                               |
| `downloads`                    | Reporting the downloads started anywhere in the browser since a browser action began, and whether one waits for a place to save it                                                                  |
| `alarms`                       | Reconnecting to the native host when the connection drops                                                                                                                                           |
| `unlimitedStorage`             | The durable queue of Slack events waiting for the app's acknowledgement                                                                                                                             |

## Security

The extension's Slack transport runs in the user's signed-in Slack tab, alongside Slack's own code.

Scripts already running in the Slack page are out of scope: Slack's own code, or another extension's script in the page's world. Such a script already holds the user's session and token and can send them anywhere itself. The private channel between the observer and the relay, and the check that sends the token only to the workspace's address on Slack's domain, run on built-ins a page script could replace, and they are not hardened against that. The relay first takes its channel before any of the page's scripts run; a relay the service worker injects after the extension reloaded takes one while they run, so a page script could hand it a port of its own, whose messages the relay checks like any other and passes on only as events and status. The service worker injects that relay only into the top document it checked to be a Slack page, and the relay takes a channel only in the top frame of a page on `https://app.slack.com`.

The Slack transport guarantees two things:

- Its own code reads the session token only in the page, for the request a command makes, and sends it only to the workspace's https address on Slack's domain. What the page returns to the extension is the signed-in account (its ids and the workspace's name), Slack's answers and file bytes as Slack sent them, whether Slack's socket is open, and new messages cut down to the fields the app reads. None of it is the token the page reads from Slack's saved client state, though a credential someone wrote into a message or a file comes back like any other content. A command that fails in the page answers a fixed code, never an error message that could quote what the page holds. Chrome also supplies each request's authentication fields, the session token and cookie included, to the service worker's network observer below, which redacts them before recording.
- Slack message content, which is remote data and never runs as script, can't trigger a command, an API call or an ack. A new message only ever becomes an event, keyed by the account its tab was signed in as when it came, and dropped if the tab has switched accounts since. Commands reach the extension only from the native host, and the relay passes an ack on only from the client that listens for events.

The browser tools reach every site the browser has open, by design: they read and drive the user's tabs for the model. The browser hands the service worker every fetch and XHR request a tab sends, Slack's included, credentials and all, and the service worker redacts each one before recording it for the network log: a body field (URL-encoded, JSON or multipart), query parameter or header whose name holds a credential word (`token`, `password`, `secret`, `apikey`, `authorization`, `cookie` and others) shows as `[redacted]` with its name kept, and so does any value shaped like a known token, key or Bearer value. Every structured URL field a tab command answers (a tab's, a page's, a download's) is redacted the same way; a URL in page text or a field value comes back as the page shows it. The redaction goes by name and pattern, so an opaque credential under an ordinary name, such as the key in a share link, passes unchanged. The tab commands never read a page's localStorage or the cookie store. A page's outline is its visible text and controls as the page shows them, a password field's value included only as filled or empty, and page text, ordinary field values and screenshots return whatever the page shows, a credential it displays included.

On the Mac, the socket that carries commands sits in a folder only the user can open (see the native host step above), and when two browsers start their hosts at once, the hosts take the socket over one at a time.

## Development

Node 24 and pnpm 11:

```sh
pnpm install
pnpm run typecheck && pnpm run lint && pnpm run format:check && pnpm test
```
