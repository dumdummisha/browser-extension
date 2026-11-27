# Security model

What the Misha Browser extension, its native host and the tools can reach, what they record and keep, and what is out of scope. The [README](../README.md#security-at-a-glance) has the short version.

## What the extension asks for

The extension asks for `nativeMessaging`, `scripting`, `tabs`, `webRequest`, `downloads`, `alarms` and `unlimitedStorage`, and for access to all sites. [Browser permissions](https://docs.dumdummisha.ai/reference/permissions) explains what each one lets the extension do, when data flows and its limits, and the [privacy policy](https://docs.dumdummisha.ai/privacy) covers what happens to the data. Both draw on [`docs/store-disclosures.json`](store-disclosures.json), from which `pnpm run disclosures` generates the Chrome Web Store text in [`docs/store-permissions.md`](store-permissions.md).

## Acting in your signed-in sessions

The browser tools act through the user's signed-in sessions on every site the browser has open, by design: they read pages, take screenshots, and click and type into the user's tabs for the model.

## The network log

The service worker records every tab's fetch and XHR requests for as long as it runs, not only during a tool call. The browser exposes each request's credentials, Slack's token and cookie included, to the service worker temporarily, for redaction: it redacts them by name and pattern before recording, so an opaque credential under an ordinary name, such as the key in a share link, passes unchanged. The rest of a body is recorded as sent, including any personal, health, financial or location data in it. The log stays in memory, and the same redaction applies to every structured URL a tab command returns.

## Page text redaction

Page text a tab command returns (outlines, search hits, change reports, titles, field values, element descriptions, option labels, download names and error messages) has each span shaped like a known credential replaced with `[redacted]`: Slack, GitHub and Google tokens, AWS access key ids, OpenAI and Anthropic API keys, JSON Web Tokens, Bearer values and PEM private keys.

The service worker redacts it on the way to the native host, after a search has matched the unredacted page and a change report has compared unredacted outlines. This is known credential-shape redaction, not a secret detector: a credential of another form comes back as the page shows it, and so does a private key whose BEGIN line is outside what the read captured. Screenshots are not redacted, so an agent should not read or screenshot a page that shows a credential.

## Reading Slack's own requests

On Slack's pages the service worker also reads the requests Slack's own client sends, headers and bodies included, for the Slack transport: to check the transport's requests against the client's. Inside the listener it keeps only field names and the values of listed transport fields in their expected forms; the token, the cookie, a call's arguments and an upload's address are dropped there, and a name shaped like a secret is never kept.

The check compares the request envelope: header names and listed header values, query field names, the client's own `_x_` body fields and the encoding. It leaves out `_x_id` and `_x_reason`, which belong to one request and to the action behind one client call, and every other body field, which is the call's arguments, so a reported difference means the envelope drifted. A body Chrome hands over as raw bytes is not read, so a comparison with it never reports a match. Its status leaves the extension with names only.

The query a Slack call borrows comes from the page instead: the observer receives the page's resource timing entries, reads the address only of the XHR requests Slack's client sends, and keeps per workspace only the listed session fields of the client's latest Web API call, such as `_x_csid` and `slack_route`, in their expected forms. It passes them only to the relay, which gives them to the service worker for a Web API call the Misha app asks for. They stay in the page's memory for the document's lifetime, also while the extension is off, and are never written to disk.

## Hidden elements, field values and the pointer

Page reads skip hidden elements while they walk the page, but a visible label lists the state of the hidden control it stands for, a hidden text field's value included, and a ref they handed out keeps reading its element after the page hides it.

A password field comes back only as filled, empty or its length, while the extension keeps the last raw value it read from each field, password or not, in the page's isolated world until a later read or the document unloads. Once a tool locates a target on a page (a click, drag, scroll, typing into a referenced field or a screenshot), the extension keeps the latest pointer position there until the document unloads.

## What stays in memory

The service worker keeps some data in memory across requests: each tab's unredacted page outline from before its last click, drag, key press, option pick, or submitting or focused typing, until another of those replaces it (navigating and scrolling do not), the tab closing or the worker stopping, and a Slack file transfer until it completes or the worker stops. An open native host connection keeps the worker running, so that can last as long as the browser runs.

## The Slack transport

The Slack transport reads the session token only in the page and sends it only to the workspace's https address on Slack's domain.

The one thing it writes in the page is Slack's own activity-session entry for the workspace in the localStorage of `https://app.slack.com` (`activitySession_` and the team id, or the enterprise id in an Enterprise Grid), right before each Web API call, an upload's two Web API calls included: it extends the active session or starts one and prunes entries idle for over a day, as Slack's client does on a user's input, and sends the session's id as `_x_csid`. The entry holds session metadata (each session's id, start and last activity, and a new session's definition version), and fields Slack's client stored on a session, such as whether it ended or what its usage reporting queued, stay as stored. Fetching or posting a file's bytes records nothing.

Slack's web client reads the same entry in the profile's Slack tabs on that workspace or Enterprise Grid: for 60 seconds after each of Misha's calls its own calls carry that session, and its usage reporting reports the sessions to Slack as time spent in Slack (start, refresh and end), so Misha's calls count there as the user's own activity.

It returns the signed-in account, Slack's answers and file bytes, whether Slack's socket is open, and new messages cut down to the fields the app reads. It does not return the token it reads from Slack's saved client state, though a credential someone wrote into a message or a file comes back like any other content.

Downloads come only from `files.slack.com` with redirects refused, but an upload goes to whatever upload URL Slack's answer names: the extension does not check its host, though the bytes refuse redirects, and the service worker holds the URL between the upload's two stages without sending it to the app.

Requests go out one at a time per workspace, a random 0.5 to 2 seconds after the previous one handed to the page ended, unless the page's answer showed that one sent nothing (it was signed in as another account, or failed before its fetch); one whose answer was lost or did not read counts as sent and is not sent again.

The send boundary is the moment a command is handed to the page: the extension checks right before it that the caller has not cancelled and its deadline has not passed, and the page checks the deadline once more right before its fetch. A cancel that arrives after the hand-off is too late, as one after a fetch started would be.

## The event queue

New messages wait in an IndexedDB queue of at most 2000 events until the app acknowledges them. While writes to it fail, up to another 2000 are held in memory and forwarded from there, and a restart before a write succeeds loses those the app has not acknowledged, with no record of the loss.

## What Slack content cannot do

Slack message content, which is remote data and never runs as script, can't trigger a command, an API call or an ack. A new message only ever becomes an event, keyed by the account its tab was signed in as when it came, and dropped if the tab has switched accounts since. The client query the observer keeps only shapes the envelope of a call the Misha app asked for, and never starts one. Commands reach the extension only from the native host, and the relay passes an ack on only from the client that listens for events.

## The socket on the Mac

On the Mac, the socket that carries commands sits in a folder only the user can open (see [The native host](native-host.md)), and when two browsers start their hosts at once, the hosts take the socket over one at a time.

## Out of scope

Scripts already running in the Slack page are out of scope: Slack's own code, or another extension's script in the page's world. Such a script already holds the user's session and token and can send them anywhere itself.

The private channel between the observer and the relay, and the check that sends the token only to the workspace's address on Slack's domain, run on built-ins a page script could replace, and they are not hardened against that. The relay first takes its channel before any of the page's scripts run; a relay the service worker injects after the extension reloaded takes one while they run, so a page script could hand it a port of its own, whose messages the relay checks like any other and passes on only as events, status and the client query of a call the Misha app asked for. The service worker injects that relay only into the top document it checked to be a Slack page, and the relay takes a channel only in the top frame of a page on `https://app.slack.com`.
