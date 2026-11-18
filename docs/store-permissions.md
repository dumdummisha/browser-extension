# Chrome Web Store permission justifications

The Misha Browser extension (`src/extension/manifest.json`) asks for the permissions below. Each paragraph is written to be pasted into the store's "permission justification" field for that permission. The extension talks only to its native messaging host on the same Mac: it has no server of its own and loads no remote code.

The extension does two jobs. Its Slack transport reads new messages in the user's signed-in Slack tab and makes allowlisted Slack Web API calls there for the Misha app. Its tab commands let the browser tools of misha-browser's MCP server (`tab_*`) read and drive the user's tabs.

## Permissions

### `nativeMessaging`

Connects to the extension's native messaging host, `misha.browser_bridge`, which the user installs on their own Mac. It is the extension's only channel: the Misha app's Slack requests and the browser tools' tab commands arrive through it, and replies, new Slack messages and the extension's status go back through it. Nothing is sent to a remote server.

### `scripting`

Runs the extension's own bundled functions in a tab. In a signed-in Slack tab it reads which workspace and user the tab is signed in as, and makes the allowlisted Slack Web API calls, file downloads and uploads the Misha app asks for. In the tab a browser tool names, it reads the page as an outline of its visible text and controls (`tab_read`, `tab_find`), finds where a control sits so the tool can click or type into it, reads a form field's state, picks an option in a select, and waits until the page stops changing after an action.

### `tabs`

Lists the open tabs with their titles and URLs for `tab_list`, and lets `tab_open`, `tab_switch` and `tab_close` open, focus and close tabs. The Slack transport uses it to find the open Slack tabs and to report its status again when one loads or closes. Every URL a tab command returns has credentials in its query, path or userinfo redacted.

### `webRequest`

Observes the fetch and XHR requests a tab sends. `tab_network` lists them (method, URL, request body, headers, status) so the model can learn the API a web app calls, and the action tools wait for the requests an action started before they read the page again. It only observes and never blocks or changes a request. Each request is redacted as it is recorded: a body field, query parameter or header named like a token, password, secret, API key, authorization or cookie, and any value shaped like a known token or key, is replaced with `[redacted]`. The log holds the latest 200 requests per tab in memory, never stores response bodies and is never written to disk.

### `downloads`

Reports the downloads an action started, so a browser tool can tell the model that a click downloaded a file, where it was saved and whether it finished. It only searches the download list. It never starts, opens or deletes a download.

### `alarms`

Reconnects to the native messaging host every 30 seconds while the host is not running, for example before the user has installed it or after it stopped.

### `unlimitedStorage`

Keeps the Slack transport's pending queue in IndexedDB: new Slack messages wait there until the Misha app confirms it saved them, so they survive a service worker or browser restart. Without this permission Chrome may evict the extension's IndexedDB under storage pressure, taking the queued messages and the count of lost ones with it.

### Host permission `<all_urls>`

The browser tools work on whatever site the user has open, so the extension needs access to every site: to read and drive a page with `scripting`, to record its requests with `webRequest`, and to capture the visible part of a tab for `tab_screenshot`. A page's content is read only when a browser tool asks for it, and its requests are recorded as described under `webRequest`.

### Content scripts on `https://app.slack.com/*`

Two scripts run in Slack tabs from the moment a page starts loading. One watches Slack's own real-time socket and passes on each new message cut down to the fields the Misha app reads, such as its channel, timestamp, author, text and thread, and the ids of any files it shares. The other checks what the first one sends and forwards it to the service worker. Neither sends anything on Slack's socket.

The manifest asks for no other permission: not `debugger`, `cookies`, `webRequestBlocking`, `history` or `bookmarks`.

## How the Slack session stays on the Slack page

Only one piece of code uses the Slack token: the function the service worker injects into a Slack tab's own page (`src/service-worker/slack-page.ts`). For each call the Misha app asks for, it reads the token from Slack's saved client state, adds it to the request, and sends that request only to the workspace's https address on Slack's domain, with redirects refused. What the function hands back is checked against a fixed shape: the account's ids and the workspace's name, Slack's answer, file bytes or an uploaded file's id. A command that fails returns a fixed failure code, so no error message can quote what the page holds.

The other ways out of the Slack page carry no token either. The script that watches Slack's socket reads only the signed-in user's id from the saved state, never passes on the socket's address (which holds a token), and sends only whether the socket is open and new messages cut down to fixed fields, with the account the tab showed. Its partner script and the service worker reject anything outside those shapes. The native host passes these messages between the extension and the Misha app and keeps nothing.

No tab command can return the token, on the Slack tab or any other:

- The page commands behind `tab_read`, `tab_find`, page outlines, field values and their errors run in the extension's isolated world, not the page's. They read only the page's DOM, skip script and head content and hidden inputs, and report a password field only as filled or empty. None reads localStorage, cookies or the page's scripts.
- `tab_network` records requests already redacted, so the token Slack's client and the extension post as the `token` field, and the session cookie in the `Cookie` header, show as `[redacted]`. WebSocket connections are not recorded.
- `tab_screenshot` returns only the pixels the tab shows. It reads no page state.

Scripts that already run in the Slack page (Slack's own code, or another extension's) are out of scope: they hold the session themselves. The README's Security section states this threat model.
