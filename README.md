# Misha Browser

<img src="https://docs.dumdummisha.ai/logo.svg" alt="The Dumdum Misha mascot" width="72" height="72">

**Connect local AI agents to your signed-in browser.**

The Misha Browser extension and its native host, a small program on your Mac, let a local agent read and act in the browser you already use. They also carry Slack to the Misha app. The package is named `misha-browser`.

- **Setting up the Misha app?** Follow [Get started](https://docs.dumdummisha.ai/start/get-started). Misha installs the native host itself, so you need none of the build steps below.
- **Using the tools in your own agent?** Build this repository and [use the MCP server](#use-the-mcp-server). This needs neither the Misha app nor an invite.
- **Building on the client library?** See [Library API](#library-api).

Status: macOS only, in Chrome or Brave. The extension has no Chrome Web Store listing yet, so you load it unpacked.

## How it fits together

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

## Security at a glance

- The extension has access to all sites: when an agent asks, it reads pages and clicks and types in your tabs through your signed-in sessions, as you.
- Page text it returns has only known credential shapes redacted, and screenshots have nothing redacted.
- While it runs, it records every tab's fetch and XHR requests, with credentials redacted by name and pattern, which misses an opaque credential under an ordinary name.
- On Slack's pages it also reads the requests Slack's own client sends, and keeps only listed transport fields.
- Any program running as you on the Mac can connect to the native host's socket and drive the browser through it.

The [security model](docs/security.md) states each of these in full, with the threat model. [Browser permissions](https://docs.dumdummisha.ai/reference/permissions) explains each permission and its limits, and the [privacy policy](https://docs.dumdummisha.ai/privacy) covers where the data goes.

## Use the MCP server

The server is `dist/mcp/server.js`, the package's `misha-browser-mcp` bin. It serves two sets of tools to any MCP client:

| Tools              | What they do                                                                         | Source                        |
| ------------------ | ------------------------------------------------------------------------------------ | ----------------------------- |
| Browser, `tab_*`   | Read and drive your own browser through the extension                                | [`src/tools/`](src/tools)     |
| Desktop, `macos_*` | Move the Mac's mouse, press its keys, capture its screen and bring apps to the front | [`src/desktop/`](src/desktop) |

A page reads as a compact outline of headings, visible text and numbered controls instead of HTML. Clicks, typing, key presses and scrolling are real input, so pages get the same events a person makes. The tools run on macOS only; elsewhere they stay listed and each one says so when called.

Build first, then register the server with the absolute path of this checkout:

```sh
pnpm install && pnpm run build
```

Claude Code:

```sh
claude mcp add --scope user misha-browser -- node /absolute/path/to/browser-extension/dist/mcp/server.js
```

OpenCode 2, in `opencode.json`. `codemode: false` lists each tool by its own name instead of behind OpenCode's `execute` tool:

```json
{
  "mcp": {
    "servers": {
      "misha-browser": {
        "type": "local",
        "command": ["node", "/absolute/path/to/browser-extension/dist/mcp/server.js"],
        "codemode": false
      }
    }
  }
}
```

The browser tools also need the extension and its native host: see [Install from source](#install-from-source).

## Permissions

The tools that move the mouse, press keys or capture the screen need two macOS permissions: Accessibility and Screen Recording (Screen & System Audio Recording on recent macOS). Input fails without either.

| Tools                                                                                                                                                 | Needs                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `tab_click`, `tab_drag`, `tab_type`, `tab_fill`, `tab_press`, `tab_scroll`, every `macos_mouse_*` and `macos_keyboard_*` tool, `macos_screen_capture` | Both permissions                                                                     |
| `tab_select_option`                                                                                                                                   | Both, only when the change starts a download that waits in the browser's save dialog |
| Every other `tab_*` tool, `macos_list_apps`, `macos_focus_app`                                                                                        | Nothing                                                                              |

Grant both to the app that runs Claude Code or OpenCode: the terminal, the editor whose terminal you use, or the desktop app. In System Settings > Privacy & Security, turn the app on in each list, or add it with + if it is missing. Then quit the app completely and open it again, because a running app keeps failing until it restarts.

## Install from source

Both the extension and the native host run on macOS, in Chrome or Brave.

1. Build. The unpacked extension lands in `dist/extension`.

   ```sh
   pnpm install && pnpm run build
   ```

2. Install the native host. This registers it with Chrome, Brave or both, so that only this extension can start it. Run it again after a Node upgrade.

   ```sh
   pnpm run install-host
   ```

3. Open `brave://extensions` or `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick `dist/extension`. Its id is `lkibgdfhoikfdbkhdlnoiajfelcmohjj`, fixed by the public key in the manifest. After a rebuild, reload it there.
4. Reload any Slack tab that was already open when you first loaded the extension. Such a tab shows as signed in but not capturing until it reloads.

Once the browser has started the host, clients connect to `~/.misha/browser-bridge/bridge.sock`.

[The native host](docs/native-host.md) covers what the installer writes, the errors it stops with and what a reload keeps. Upgrading an existing install? See the [changelog](CHANGELOG.md).

## Library API

The Misha app builds on these entry points of the `misha-browser` package:

| Import                           | What it gives you                                                                |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `misha-browser/protocol`         | The wire protocol's messages and types                                           |
| `misha-browser/protocol/framing` | The framing helpers, for Node processes                                          |
| `misha-browser/client`           | A Node client for the native host's socket                                       |
| `misha-browser/native-host`      | The launcher text and native messaging manifest the host installer writes        |
| `misha-browser/modules`          | `browserModule` and `desktopModule`, which build the tools for a Misha extension |

[Protocol and library](docs/protocol.md) describes the handshake, what the protocol carries and each entry point.

## What the repository holds

| Part          | Folder                                  | Purpose                                                               |
| ------------- | --------------------------------------- | --------------------------------------------------------------------- |
| Wire protocol | `src/protocol/`                         | How the extension, the native host and its clients talk to each other |
| Extension     | `src/extension/`, `src/service-worker/` | The Manifest V3 extension: page reads, input and the Slack transport  |
| Native host   | `src/host/`                             | Carries traffic between the extension and processes on the same Mac   |
| Client        | `src/client/`                           | A Node client for the host's socket                                   |
| Browser tools | `src/tools/`                            | The `tab_*` tools                                                     |
| Desktop tools | `src/desktop/`                          | The `macos_*` tools                                                   |
| MCP server    | `src/mcp/`                              | Serves both sets of tools over stdio                                  |
| Store packet  | `docs/store/`                           | What the Chrome Web Store listing will need                           |

## Development

Node 24 and pnpm 11:

```sh
pnpm install
pnpm run typecheck && pnpm run lint && pnpm run format:check && pnpm test
```

[The store packet](docs/store/README.md) covers `pnpm run store-archive` and `pnpm run render-icons`.

## Related repositories

- [dumdummisha/docs](https://github.com/dumdummisha/docs): the documentation site at [docs.dumdummisha.ai](https://docs.dumdummisha.ai), including the Misha app's setup, privacy policy and architecture.
- [dumdummisha/desktop-downloads](https://github.com/dumdummisha/desktop-downloads): signed Misha desktop builds and the app's update feed.

## Licence

[Apache License 2.0](LICENSE).
