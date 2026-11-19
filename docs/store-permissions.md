# Chrome Web Store permission justifications

The Misha Browser extension (`src/extension/manifest.json`) asks for the permissions below. Each paragraph is written to be pasted into the store's "permission justification" field for that permission. The extension has no backend of its own and loads no remote code. The Slack API and file requests it makes run inside the user's signed-in Slack page and go to Slack.

The extension does two jobs. Its Slack transport reads new messages in the user's signed-in Slack tab and makes allowlisted Slack Web API calls there for the Misha app. Its tab commands let the browser tools of misha-browser's MCP server (`tab_*`) read and drive the user's tabs.

## Permissions

### `nativeMessaging`

Connects only to the native messaging host `misha.browser_bridge`, which the user installs locally on their own Mac. The Misha app's Slack requests and the browser tools' tab commands arrive through it, and replies, new Slack messages and the extension's status go back through it. Slack API and file traffic runs separately, in the signed-in Slack page, and the extension has no separate backend.

### `scripting`

Runs the extension's own bundled functions in a tab. In a signed-in Slack tab it reads which workspace and user the tab is signed in as, and makes the allowlisted Slack Web API calls, file downloads and uploads the Misha app asks for. After the extension reloads or updates, it injects the extension's own relay script again into each open Slack tab whose copy the browser has cut off, so capture goes on without reloading the tab (see the content scripts below). It first checks, in the extension's isolated world, that the tab's top document is a page on `https://app.slack.com` with no relay of the running extension, and injects into that document only, never into a page the tab navigated to meanwhile. In the tab a browser tool names, it reads the page as an outline of its visible text and controls (`tab_read`, `tab_find`), finds where a control sits so the tool can click or type into it, reads a form field's state, picks an option in a select, and waits until the page stops changing after an action.

### `tabs`

Lists the open tabs with their titles and URLs for `tab_list`, and lets `tab_open`, `tab_switch` and `tab_close` open, focus and close tabs. The Slack transport uses it to find the open Slack tabs and to report its status again when one loads or closes. Each structured URL field a tab command returns (a tab's, a page's or a download's) goes through the name- and pattern-based redaction described under `webRequest`, which also removes a URL's userinfo and the grant in Slack's upload URLs. An opaque link that grants access under an ordinary name passes unchanged, and a URL that appears in page text or a field value comes back as the page shows it.

### `webRequest`

Observes the fetch and XHR requests a tab sends. `tab_network` lists them (method, URL, request body, headers, status) so the model can learn the API a web app calls, and the action tools wait for the requests an action started before they read the page again. It only observes and never blocks or changes a request. Chrome hands the service worker each request's body and headers, credentials included, and the service worker redacts them before it records the request: a body field, query parameter or header named like a token, password, secret, API key, authorization or cookie, and any value shaped like a known token or key, is replaced with `[redacted]`. Matched credential values are replaced before storage; an unrecognized credential can remain. The log holds the latest 200 requests per tab in memory, never stores response bodies and is never written to disk.

### `downloads`

Searches the browser's download list for downloads started since a browser tool's action began, and reports each match (its URL after name- and pattern-based redaction, which can leave an unrecognized credential, its local filename, state and bytes received), so the tool can tell the model that a click downloaded a file and whether it finished. The search covers the whole browser, not only the tab the action ran in, so a download started elsewhere in that time is reported too. The extension only searches the download list. It never starts, opens or deletes a download.

### `alarms`

Reconnects to the native messaging host every 30 seconds while the host is not running, for example before the user has installed it or after it stopped.

### `unlimitedStorage`

Keeps the Slack transport's pending queue in IndexedDB: new Slack messages wait there until the Misha app confirms it saved them, so they survive a service worker or browser restart. Without this permission Chrome may evict the extension's IndexedDB under storage pressure, taking the queued messages and the count of lost ones with it.

### Host permission `<all_urls>`

The browser tools work on whatever site the user has open, so the extension needs access to every site: to read and drive a page with `scripting`, to record its requests with `webRequest`, and to capture the visible part of a tab for `tab_screenshot`. A page's content is read only when a browser tool asks for it, and its requests are recorded as described under `webRequest`. The Slack transport's capture in Slack tabs is described under the content scripts below.

### Content scripts on `https://app.slack.com/*`

Two scripts run in Slack tabs from the moment a page starts loading. One watches Slack's own real-time socket and passes on each new message cut down to the fields the Misha app reads, such as its channel, timestamp, author, text and thread, and the ids of any files it shares. The other checks what the first one sends and forwards it to the service worker. Neither sends anything on Slack's socket. When the extension reloads or updates, the browser cuts the second script in every open tab off from the extension and loads the manifest's scripts only into pages that load afterwards, so the service worker injects the second script again into each open Slack tab, where it takes a new channel from the first one, which has kept watching the socket and held any new message that came while no relay ran. This works for pages that loaded with this version of the first script; a page still running an older version of the first script captures again only once the tab reloads, so upgrading from such a build needs each open Slack tab reloaded once.

The manifest asks for no other permission: not `debugger`, `cookies`, `webRequestBlocking`, `history` or `bookmarks`.

## Where Slack's credentials go

The function the service worker injects into a Slack tab's own page (`src/service-worker/slack-page.ts`) is the only code that uses the Slack session token. For each call the Misha app asks for, it reads the token from Slack's saved client state, adds it to the request, and sends that request only to the workspace's https address on Slack's domain, with redirects refused. It returns the account's ids and the workspace's name, Slack's answer, file bytes or an uploaded file's id. It never returns the token it reads from Slack's saved client state as session state, though a credential someone wrote into a message or a file comes back like any other content. Slack's answers and file bytes go on as Slack sent them, without credential filtering. A command that fails returns a fixed failure code, so no error message can quote what the page holds.

The script that watches Slack's socket reads only the signed-in user's id from the saved state and never passes on the socket's address, which holds a token. It sends only whether the socket is open and new messages cut down to fixed fields, with the account the tab showed. Message text goes on as written. Its partner script and the service worker reject anything outside those shapes. The native host passes messages between the extension and the Misha app and keeps nothing.

The exception is `webRequest`. Chrome gives the service worker the body and headers of every fetch and XHR request a tab sends, Slack's included, so the token in the `token` field of Slack's API calls and the session cookie in the `Cookie` header reach the service worker briefly. It redacts both before it records the request, so `tab_network` shows them as `[redacted]`, and neither is stored or sent to the native host.

What the tab commands can return, on the Slack tab or any other:

- The page commands behind `tab_read`, `tab_find` and field reads run in the extension's isolated world and read the page's DOM. They do not read Slack's saved session, a page's localStorage or the cookie store. They skip script and head content and hidden inputs, and give a password field's value only as filled or empty in an outline, or as its length in a field read. Page text, control names and ordinary field values come back as the page shows them, so a credential the page displays, or one pasted into a Slack message, comes back too.
- `tab_screenshot` returns the pixels the tab shows, including any credential on screen.
- Network requests and returned URLs are redacted by name and pattern only. An opaque credential under an ordinary name, such as the key in a share link, comes back unchanged.

Scripts that already run in the Slack page (Slack's own code, or another extension's) are out of scope: they hold the session themselves. The README's Security section states this threat model.
