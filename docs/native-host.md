# The native host

The native host is a small program the browser starts for the extension. It carries requests, cancels, replies, events and acks between the extension and processes on the same Mac, through a socket only you can open. The [README](../README.md#install-from-source) has the install steps; this page has the detail behind them.

## What the installer does

`pnpm run install-host` runs `node dist/host/install.js dist/extension`. The installer takes the unpacked extension's folder as its one argument. It registers the id of that folder's extension and prints the folder to load. The Misha app passes the folder it ships.

The installer writes two things:

- A launcher at `~/.misha/browser-bridge/native-host`. The launcher runs the host with the runtime that ran the installer, named by its absolute path. From this repository that is the current Node binary, so run the installer again after a Node upgrade. The Misha app runs the installer with its own Electron executable as Node, and the launcher it writes sets `ELECTRON_RUN_AS_NODE=1` for it.
- A native messaging manifest that registers the host as `misha.browser_bridge` with Chrome, Brave or both, wherever a profile folder exists. It names exactly this extension's origin, so that only it can start the host.

It also makes `~/.misha/browser-bridge` accessible only to you (mode 700). Once the browser has started the host, clients connect to `~/.misha/browser-bridge/bridge.sock`. When two browsers start their hosts at once, the hosts take the socket over one at a time.

## Troubleshooting install-host

The installer stops with an error when:

- its folder argument is missing, is not a directory or holds no `manifest.json` with a `key`
- `~/.misha` or `~/.misha/browser-bridge` is a symlink
- either folder belongs to another user (root may own `~/.misha`)
- anyone else can write to `~/.misha`
- an ACL on either folder has an entry that allows access. `ls -le` lists the entries and `chmod -N` removes them; entries that deny are fine

## Loading the extension from inside an app

The "Load unpacked" picker shows an app as a single item it does not open. A folder inside an app, as in the Misha app, is reached with Cmd+Shift+G and its path, or by dragging it from Finder onto the picker. The installer's message says so.

## What a reload keeps

The extension reads Slack's socket from a script that has to run before Slack's own. A Slack tab that was open before you first loaded the extension therefore shows as signed in but not capturing until it reloads. The extension does not put WhatsApp's observer into a page that is already open, so a WhatsApp Web tab that was open before you first loaded the extension is listed as detached and captures nothing until it reloads.

After that, reloading the extension needs no tab reload:

- An open Slack tab keeps capturing. The service worker gives the page a new relay, which takes a channel from the page's observer, along with any new message that came while no relay ran.
- Slack calls keep working. The observer keeps the query of the latest Web API call Slack's own client made in the page, and hands it to the new relay.
- An open WhatsApp Web tab keeps capturing and taking the Misha app's requests in the same way: its observer gives the new relay a channel and the new messages that came while no relay ran. A message the page built for sending before the reload can still be sent from that page within its 2 minutes.

The extension, the native host and the client talk only when they speak the same protocol revision ([Protocol and library](protocol.md)). The [changelog](../CHANGELOG.md) lists the upgrades that need a one-time reload.
