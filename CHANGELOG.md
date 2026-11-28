# Changelog

Changes that matter to someone who runs or builds on Misha Browser. The format follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Added

- WhatsApp Web transport: new messages of your one-to-one chats go to the Misha app, and the app can read a chat's earlier messages and a contact's name and send text messages, from your signed-in WhatsApp Web tab. Groups, media, reactions and new chats are left out.

### Upgrading

- **To protocol revision 2, which adds WhatsApp:** update the Misha app and the extension together. Either one alone stops the bridge, Slack included, and shows which side to update until the other follows. Then reload each WhatsApp Web tab that was open before the extension first ran its WhatsApp scripts.
- **Across a protocol revision, or from a build before versioned hellos:** run `pnpm run install-host` again and reload the extension, which restarts its native host. The extension, the native host and the client talk only when they speak the same protocol revision.
- **From a build before commit `51b179f`, whose observer predates sequenced frames:** reload the extension, then reload each open Slack tab once. The tab's page still runs the old observer, which the new relay cannot read.
- **From a build whose observer does not keep the client's query:** reload each open Slack tab once. Until then the tab keeps capturing and downloads keep working, but its Slack calls fail with a message to reload it.
