# misha-browser

Browser extension and MCP server for browser and desktop control, with Misha's Slack transport. Apache-2.0.

So far the repository holds the wire protocol, in `src/protocol/`: how the extension, its native messaging host and relay, and the relay's clients talk to each other. It covers requests and replies, events the extension keeps in durable storage and forwards again until the app acknowledges them, signed-in identity and capture health reported apart, an allowlist of Slack Web API methods, and private file downloads and uploads in chunks under Chrome's 1 MB limit, with an upload's Slack file id known before the file is shared. The extension, the native host and the MCP server aren't written yet.

Misha's app imports the protocol as `misha-browser/protocol`. Node processes also get the framing helpers from `misha-browser/protocol/framing`.

## Development

Node 24 and pnpm 11:

```sh
pnpm install
pnpm run typecheck && pnpm run lint && pnpm run format:check && pnpm test
```
