# misha-browser

<img src="https://docs.dumdummisha.ai/logo.svg" alt="The Dumdum Misha mascot" width="72" height="72">

**Connect local AI agents to your signed-in browser.** The Misha Browser extension and its native host, a small program that connects the extension to processes on your Mac, let a local agent read and act in the browser you already use, and carry Slack to the Misha app. The same package has browser and desktop tools that Claude Code, OpenCode or any other MCP client can use through a standalone server, without the Misha app.

- **Setting up the Misha app?** Follow [Get started](https://docs.dumdummisha.ai/start/get-started) in the docs. Misha's Set up page checks the extension and installs the native host, and you don't need the build steps below.
- **Using the tools in your own agent?** Build this repository and register [the MCP server](#the-mcp-server). This route needs neither the private Misha app nor an invite.

Status: macOS only, in Chrome or Brave. You load the extension unpacked from a build of this repository; it has no Chrome Web Store listing yet. Apache-2.0.

## How it connects

```text
signed-in tab        Slack, or any page an agent reads or acts on
  |                  scripts the extension runs in the tab
service worker       the extension's background process
  |                  native messaging
native host          on your Mac, with its relay
  |                  ~/.misha/browser-bridge/bridge.sock, a socket only you can open
Misha app            Slack messages in, replies out
or the MCP server    the tab_* tools
```

The desktop tools (`macos_*`) don't go through the browser: the MCP server moves the mouse, presses keys and captures the screen itself, through macOS. [How Misha works](https://docs.dumdummisha.ai/understand/how-it-works#without-a-slack-app) explains how the Misha app uses this path for Slack.

## Security in short

- The extension has access to all sites. When an agent asks, it reads pages and clicks and types in your tabs through your signed-in sessions, as you. Page text it returns has only known credential shapes redacted, and screenshots nothing.
- While it runs, it records every tab's fetch and XHR requests, not only during a tool call. It redacts credentials by name and pattern, which misses an opaque credential under an ordinary name. On Slack's pages it also reads the requests Slack's own client sends, keeping only listed transport fields, to check that the Slack transport's requests look like the client's.
- Any program running as you on the Mac can connect to the native host's socket and drive the browser through it.
- The tools that move the mouse, press keys or capture the screen need Accessibility and Screen Recording for the app that runs your agent. See [macOS permissions](#macos-permissions).

[Browser permissions](https://docs.dumdummisha.ai/reference/permissions) explains each permission and its limits, and the [privacy policy](https://docs.dumdummisha.ai/privacy) covers where the data goes. The full detail is under [Security](#security) below.

## What this repository holds

The repository holds:

- the wire protocol, in `src/protocol/`: how the extension, its native messaging host and relay, and the relay's clients talk to each other. It covers requests and replies, each request with its caller's deadline and a way to cancel it, events the extension keeps in durable storage and forwards again until the app acknowledges them, signed-in identity and capture health reported apart, an allowlist of Slack Web API methods, and private file downloads and uploads in chunks under Chrome's 1 MB limit, with an upload's Slack file id known before the file is shared
- the Manifest V3 extension, in `src/extension/` and `src/service-worker/`. In a signed-in Slack tab it reads new messages from the page's own socket and makes allowlisted Web API calls, downloads and uploads with the session Slack's web client already has: with the query of the client's own latest Web API call in the page, one request at a time per workspace and a random 0.5 to 2 seconds apart, and none handed to the page once its caller gave up. It checks each kind of request against the client's own and reports differences by name in its status. The extension uses the session token only inside the page and does not return it; see Security for the network log, to which the browser exposes request credentials temporarily, for redaction
- the native host and its relay, in `src/host/`, which carry requests, cancels, replies, events and acks between the extension and processes on the same Mac through a socket only the user can open
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

The browser tools that only read or work through the extension (`tab_list`, `tab_read`, `tab_find`, `tab_wait`, `tab_screenshot`, `tab_network`, `tab_open`, `tab_switch`, `tab_close`), `macos_list_apps` and `macos_focus_app` need no permission. `tab_screenshot` captures through the extension, not the screen. `tab_select_option` sets the option through the extension, but when the change starts a download that waits in the browser's save dialog, the Return that accepts it goes through the input session, so that call needs both permissions too.

## Loading the extension and the native host

Both run on macOS, in Chrome or Brave.

1. Build: `pnpm install && pnpm run build`. The unpacked extension lands in `dist/extension`.
2. Install the native host: `pnpm run install-host`. It writes a launcher to `~/.misha/browser-bridge/native-host` and registers the host as `misha.browser_bridge` with Chrome, Brave or both, wherever a profile folder exists, so that only this extension can start it. The launcher names the current Node binary by its absolute path, so run it again after a Node upgrade. The installer makes `~/.misha/browser-bridge` accessible only to you (mode 700), and stops with an error when that folder or `~/.misha` is a symlink, when either belongs to another user (root may own `~/.misha`), when anyone else can write to `~/.misha`, or when an ACL on either has an entry that allows access (`ls -le` lists them, `chmod -N` removes them; entries that deny are fine).
3. Open `brave://extensions` or `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick `dist/extension`. Its id is `lkibgdfhoikfdbkhdlnoiajfelcmohjj`, fixed by the public key in the manifest. After a rebuild, reload it there. A Slack tab whose page loaded with this version's observer keeps capturing without a reload: the service worker gives the page a new relay, which takes a channel from the observer, along with any new message that came while no relay ran. Sending is different: a Slack call borrows the query of the latest Web API call Slack's own client made in the page, and the reloaded extension has seen none yet, so calls from that tab fail until the client makes one. Using Slack in the tab, such as opening a channel, or reloading the tab restores them.
4. Reload any Slack tab that was already open when you first loaded the extension. The extension reads Slack's socket from a script that has to run before Slack's own, so a tab opened earlier shows as signed in but not capturing until it reloads. The same holds once when you upgrade from a build whose observer predates sequenced frames (any build before commit `51b179f`): reload the extension, then reload each open Slack tab once, since its page still runs the old observer, which the new relay cannot read. From then on, reloading the extension needs no tab reload.

Once the browser has started the host, clients connect to `~/.misha/browser-bridge/bridge.sock`.

The extension's permissions, which an unpacked extension gets when it is loaded, are summarized under Security.

## Security

The extension asks for `nativeMessaging`, `scripting`, `tabs`, `webRequest`, `downloads`, `alarms` and `unlimitedStorage`, and for access to all sites. [Browser permissions](https://docs.dumdummisha.ai/reference/permissions) explains what each one lets the extension do, when data flows and its limits, and the [privacy policy](https://docs.dumdummisha.ai/privacy) covers what happens to the data. Both draw on [`docs/store-disclosures.json`](docs/store-disclosures.json), from which `pnpm run disclosures` generates the Chrome Web Store text in [`docs/store-permissions.md`](docs/store-permissions.md).

What that access means:

- The browser tools act through the user's signed-in sessions on every site the browser has open, by design: they read pages, take screenshots, and click and type into the user's tabs for the model.
- The service worker records every tab's fetch and XHR requests for as long as it runs, not only during a tool call. The browser exposes each request's credentials, Slack's token and cookie included, to the service worker temporarily, for redaction: it redacts them by name and pattern before recording, so an opaque credential under an ordinary name, such as the key in a share link, passes unchanged. The rest of a body is recorded as sent, including any personal, health, financial or location data in it. The log stays in memory, and the same redaction applies to every structured URL a tab command returns.
- Page text a tab command returns (outlines, search hits, change reports, titles, field values, element descriptions, option labels, download names and error messages) has each span shaped like a known credential replaced with `[redacted]`: Slack, GitHub and Google tokens, AWS access key ids, OpenAI and Anthropic API keys, JSON Web Tokens, Bearer values and PEM private keys. The service worker redacts it on the way to the native host, after a search has matched the unredacted page and a change report has compared unredacted outlines. This is known credential-shape redaction, not a secret detector: a credential of another form comes back as the page shows it, and so does a private key whose BEGIN line is outside what the read captured. Screenshots are not redacted, so an agent should not read or screenshot a page that shows a credential.
- On Slack's pages the service worker also reads the requests Slack's own client sends, headers and bodies included, for the Slack transport: to borrow the client's query and to check the transport's requests against the client's. Inside the listener it keeps only field names and the values of listed transport fields in their expected forms; the token, the cookie, a call's arguments and an upload's address are dropped there, and a name shaped like a secret is never kept. The check compares the request envelope: header names and listed header values, query field names, the client's own `_x_` body fields and the encoding. It leaves out `_x_id` and `_x_reason`, which belong to one request and to the action behind one client call, and every other body field, which is the call's arguments, so a reported difference means the envelope drifted. A body Chrome hands over as raw bytes is not read, so a comparison with it never reports a match. Its status leaves the extension with names only.
- Page reads skip hidden elements while they walk the page, but a visible label lists the state of the hidden control it stands for, a hidden text field's value included, and a ref they handed out keeps reading its element after the page hides it. A password field comes back only as filled, empty or its length, while the extension keeps the last raw value it read from each field, password or not, in the page's isolated world until a later read or the document unloads. Once a tool locates a target on a page (a click, drag, scroll, typing into a referenced field or a screenshot), the extension keeps the latest pointer position there until the document unloads.
- The service worker keeps some data in memory across requests: each tab's unredacted page outline from before its last click, drag, key press, option pick, or submitting or focused typing, until another of those replaces it (navigating and scrolling do not), the tab closing or the worker stopping, and a Slack file transfer until it completes or the worker stops. An open native host connection keeps the worker running, so that can last as long as the browser runs.
- The Slack transport reads the session token only in the page and sends it only to the workspace's https address on Slack's domain. It returns the signed-in account, Slack's answers and file bytes, whether Slack's socket is open, and new messages cut down to the fields the app reads. It does not return the token it reads from Slack's saved client state, though a credential someone wrote into a message or a file comes back like any other content. Downloads come only from `files.slack.com` with redirects refused, but an upload goes to whatever upload URL Slack's answer names: the extension does not check its host, though the bytes refuse redirects, and the service worker holds the URL between the upload's two stages without sending it to the app. Requests go out one at a time per workspace, a random 0.5 to 2 seconds after the previous one handed to the page ended, unless the page's answer showed that one sent nothing (it was signed in as another account, or failed before its fetch); one whose answer was lost or did not read counts as sent and is not sent again. The send boundary is the moment a command is handed to the page: the extension checks right before it that the caller has not cancelled and its deadline has not passed, and the page checks the deadline once more right before its fetch. A cancel that arrives after the hand-off is too late, as one after a fetch started would be.
- New messages wait in an IndexedDB queue of at most 2000 events until the app acknowledges them. While writes to it fail, up to another 2000 are held in memory and forwarded from there, and a restart before a write succeeds loses those the app has not acknowledged, with no record of the loss.
- Slack message content, which is remote data and never runs as script, can't trigger a command, an API call or an ack. A new message only ever becomes an event, keyed by the account its tab was signed in as when it came, and dropped if the tab has switched accounts since. Commands reach the extension only from the native host, and the relay passes an ack on only from the client that listens for events.
- On the Mac, the socket that carries commands sits in a folder only the user can open (see the native host step above), and when two browsers start their hosts at once, the hosts take the socket over one at a time.

Scripts already running in the Slack page are out of scope: Slack's own code, or another extension's script in the page's world. Such a script already holds the user's session and token and can send them anywhere itself. The private channel between the observer and the relay, and the check that sends the token only to the workspace's address on Slack's domain, run on built-ins a page script could replace, and they are not hardened against that. The relay first takes its channel before any of the page's scripts run; a relay the service worker injects after the extension reloaded takes one while they run, so a page script could hand it a port of its own, whose messages the relay checks like any other and passes on only as events and status. The service worker injects that relay only into the top document it checked to be a Slack page, and the relay takes a channel only in the top frame of a page on `https://app.slack.com`.

## Development

Node 24 and pnpm 11:

```sh
pnpm install
pnpm run typecheck && pnpm run lint && pnpm run format:check && pnpm test
```

The extension's icons in `src/extension/icons/` are rendered from `misha.svg` beside them, at the sizes Chrome's manifest takes for `icons`, with macOS's `sips`. The script keeps only the PNG chunks that describe pixels, so the EXIF block `sips` writes stays out of the repository:

```sh
pnpm run render-icons
```

## Related repositories

- [dumdummisha/docs](https://github.com/dumdummisha/docs): the documentation site at [docs.dumdummisha.ai](https://docs.dumdummisha.ai), including the Misha app's setup, privacy policy and architecture.
- [dumdummisha/desktop-downloads](https://github.com/dumdummisha/desktop-downloads): reserved for signed Misha desktop builds and the update feed. No signed build is available yet.
