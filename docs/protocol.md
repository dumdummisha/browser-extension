# Protocol and library

How the extension, its native messaging host and relay, and the relay's clients talk to each other, and the entry points the `misha-browser` package exports. The protocol lives in `src/protocol/`.

## The handshake

Every connection opens with a hello from each end naming one protocol revision, [`PROTOCOL_REVISION`](../src/protocol/messages.ts). Nothing else crosses the connection until both ends name the same revision, whatever their package versions. There is no negotiation between revisions.

A leg that cannot agree carries no traffic. That covers another revision, a hello that is missing or does not read, and anything else where only a hello may come. Each end reports a diagnostic with the failing leg and what to do:

- the extension, on its toolbar badge and title
- the client, as a typed error and its bridge state
- the native host, to every client that connects while its browser keeps it running

## What the protocol carries

- Requests and replies, each request with its caller's deadline and a way to cancel it.
- Events the extension keeps in durable storage and forwards again until the app acknowledges them.
- Signed-in identity and capture health, reported apart.
- An allowlist of Slack Web API methods.
- Private file downloads and uploads in chunks under Chrome's 1 MB limit, with an upload's Slack file id known before the file is shared.

## The Slack transport in the page

In a signed-in Slack tab the extension reads new messages from the page's own socket. It makes allowlisted Web API calls, downloads and uploads with the session Slack's web client already has. Each call carries the query of the client's own latest Web API call, which the page's observer keeps from the page's resource timing. It also carries the id of an activity session the extension records there, as the client does while someone uses the tab.

Requests go out one at a time per workspace, a random 0.5 to 2 seconds apart, and none is handed to the page once its caller gave up. The extension checks each kind of request against the client's own and reports differences by name in its status. It uses the session token only inside the page and does not return it.

The [security model](security.md) states what this transport reads, writes and keeps.

## Library entry points

| Import                           | Exports                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `misha-browser/protocol`         | The protocol's messages and types. Misha's app imports it.                                                                                                                                        |
| `misha-browser/protocol/framing` | The framing helpers, for Node processes.                                                                                                                                                          |
| `misha-browser/client`           | The client for the native host's socket. It waits for each connection's handshake within its caller's own deadline, set before it connects.                                                       |
| `misha-browser/native-host`      | What the host installer writes: the launcher's text for a runtime (`launcherText`, `runtimeOf`) and the native messaging manifest with the extension's one allowed origin (`nativeHostManifest`). |
| `misha-browser/modules`          | `browserModule` and `desktopModule`, through which a Misha extension serves the tools.                                                                                                            |

Three details matter to a caller:

- The client's `bridgeState()` and `onBridgeState` report the connection's state and the latest incompatibility, apart from Slack's status. The incompatibility is kept until a later handshake succeeds.
- `nativeHostManifest` takes the id that `extensionId` reads from an extension folder's manifest key. The app uses these helpers to recognize exactly the installer's files before it removes them.
- Each module has a `create` that builds its tools and a `jsonSchema` that converts a tool's input with this package's zod, so the descriptions the model reads survive.
