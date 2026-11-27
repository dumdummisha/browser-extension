# Changelog

Changes that matter to someone who runs or builds on Misha Browser. The format follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Upgrading

- **Across a protocol revision, or from a build before versioned hellos:** run `pnpm run install-host` again and reload the extension, which restarts its native host. The extension, the native host and the client talk only when they speak the same protocol revision.
- **From a build before commit `51b179f`, whose observer predates sequenced frames:** reload the extension, then reload each open Slack tab once. The tab's page still runs the old observer, which the new relay cannot read.
- **From a build whose observer does not keep the client's query:** reload each open Slack tab once. Until then the tab keeps capturing and downloads keep working, but its Slack calls fail with a message to reload it.
