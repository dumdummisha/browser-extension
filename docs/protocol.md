# Protocol and library

How the extension, its native messaging host and relay, and the relay's clients talk to each other, and the entry points the `misha-browser` package exports. The protocol lives in `src/protocol/`.

## The handshake

Every connection opens with a hello from each end naming one protocol revision, [`PROTOCOL_REVISION`](../src/protocol/messages.ts). Nothing else crosses the connection until both ends name the same revision, whatever their package versions. There is no negotiation between revisions.

A leg that cannot agree carries no traffic. That covers another revision, a hello that is missing or does not read, and anything else where only a hello may come. Each end reports a diagnostic with the failing leg and what to do:

- the extension, on its toolbar badge and title
- the client, as a typed error and its bridge state
- the native host, to every client that connects while its browser keeps it running

### Upgrading to revision 2

Revision 2 added WhatsApp: its events beside Slack's, each WhatsApp Web tab in the status, and the four WhatsApp methods. The extension and the Misha app, which ships the native host and the client, have to be updated together. While one of them speaks revision 2 and the other revision 1, the leg between the extension and the native host carries nothing, Slack included, and both ends say which side to update:

- An extension newer than the app shows `!` on its toolbar badge, and its title ends "Update Misha, then restart the browser to restart its native host." The native host tells the app the same.
- An app newer than the extension gets the same diagnostic from its native host, ending "Update Misha Browser in Chrome, then reload the extension. If Chrome has not received it yet, wait for the store update." The extension's badge and title say the same.

Built from this repository, the extension and the native host move together: rebuild, run `pnpm run install-host` again and reload the extension. A WhatsApp Web tab that was open before the extension first ran its WhatsApp scripts captures nothing until it reloads once.

## What the protocol carries

- Requests and replies, each request with its caller's deadline and a way to cancel it.
- Events the extension keeps in durable storage and forwards again until the app acknowledges them: new Slack messages and new messages of one-to-one WhatsApp chats.
- Signed-in identity and capture health, reported apart: for each Slack tab, and for each WhatsApp Web tab.
- An allowlist of Slack Web API methods.
- Four WhatsApp methods: `whatsappSendPrepare` and `whatsappSendCommit`, the two steps of a send, `whatsappHistory` for a chat's earlier messages and `whatsappContact` for a contact's name.
- Private file downloads and uploads in chunks under Chrome's 1 MB limit, with an upload's Slack file id known before the file is shared.

## The Slack transport in the page

In a signed-in Slack tab the extension reads new messages from the page's own socket. It makes allowlisted Web API calls, downloads and uploads with the session Slack's web client already has. Each call carries the query of the client's own latest Web API call, which the page's observer keeps from the page's resource timing. It also carries the id of an activity session the extension records there, as the client does while someone uses the tab.

Requests go out one at a time per workspace, a random 0.5 to 2 seconds apart, and none is handed to the page once its caller gave up. The extension checks each kind of request against the client's own and reports differences by name in its status. It uses the session token only inside the page and does not return it.

The [security model](security.md) states what this transport reads, writes and keeps.

## The WhatsApp transport in the page

In a signed-in WhatsApp Web tab the extension reads new messages of one-to-one chats from WhatsApp Web's own message store, through the page's module system, never its DOM. When the Misha app asks, it reads a chat's earlier messages from the page's local database, reads a contact's name, and sends a text message in two steps: `whatsappSendPrepare` builds the message in one page and answers its id with that page's token, and `whatsappSendCommit` sends exactly that message from that page. Only a commit's sent says WhatsApp's server took the message; the message's own event says only that it is in the account's message store. Every rejection of a commit leaves the outcome unknown, whatever its text. The extension's own errors after the commit was handed to the page say so in words; the client's errors for a commit the extension did not answer in time, or that the caller abandoned, do not, and mean the same.

Builds and sends go one at a time per account, a random 0.5 to 2 seconds after the previous one handed to the page ended, unless the page answered that it did nothing. Reads are not paced. Groups, reactions, media, new chats, read receipts and typing state are outside what it does, and a text with a link goes out without the preview WhatsApp Web adds when you type one.

The extension lists a WhatsApp tab once the page in it has answered the extension directly. A page that has just loaded, or that was restored from the back/forward cache, shows up as soon as it tells the extension it is there, normally within a moment. A page whose tab crashed is not noticed before the next command to it, and reloading the tab brings it back; when this was tried in a Chromium browser, that command was refused with nothing sent and the tab left the status.

The [security model](security.md) states what this transport reads, sends and keeps.

## Library entry points

| Import                           | Exports                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `misha-browser/protocol`         | The protocol's messages and types. Misha's app imports it.                                                                                                                                        |
| `misha-browser/protocol/framing` | The framing helpers, for Node processes.                                                                                                                                                          |
| `misha-browser/client`           | The client for the native host's socket. It waits for each connection's handshake within its caller's own deadline, set before it connects.                                                       |
| `misha-browser/native-host`      | What the host installer writes: the launcher's text for a runtime (`launcherText`, `runtimeOf`) and the native messaging manifest with the extension's one allowed origin (`nativeHostManifest`). |
| `misha-browser/modules`          | `browserModule` and `desktopModule`, through which a Misha extension serves the tools.                                                                                                            |

Three details matter to a caller:

- The client's `bridgeState()` and `onBridgeState` report the connection's state and the latest incompatibility, apart from Slack's and WhatsApp's status. The incompatibility is kept until a later handshake succeeds.
- `nativeHostManifest` takes the id that `extensionId` reads from an extension folder's manifest key. The app uses these helpers to recognize exactly the installer's files before it removes them.
- Each module has a `create` that builds its tools and a `jsonSchema` that converts a tool's input with this package's zod, so the descriptions the model reads survive.
