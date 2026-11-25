# Chrome Web Store packet

What the Chrome Web Store listing of Misha Browser needs, prepared in this repository. Nothing here has been uploaded: no store item exists yet, and creating one, uploading the archive, submitting it for review and publishing it each wait for the owner's approval.

The extension keeps its current identity until then: the public key in `src/extension/manifest.json` and the id `lkibgdfhoikfdbkhdlnoiajfelcmohjj` derived from it, which the native host's `allowed_origins` names. The store assigns an item its own id. Adopting it (the item's public key in the manifest, the host's one allowed origin, the Misha app's expectations) is a separate change made once the item exists.

## The archive

```sh
pnpm install
pnpm run store-archive
```

This builds the extension and packs `dist/store-archive/misha-browser-<version>.zip`: `manifest.json` at the archive's root, the service worker and the two content scripts as built (bundled, not minified), and the four icons the manifest names. Nothing else goes in: no native host or MCP server code, no source maps, no specs, no folder around the files. The archive's manifest leaves out `key`; the built extension in `dist/extension` keeps it, so the unpacked extension keeps its id.

The version is the one in `package.json`. The build writes it into the manifest and fails on one Chrome does not accept (one to four dot-separated integers from 0 to 65535, without leading zeros, not all zero). Raise it before each upload: the store refuses an archive whose version is not higher than the published one.

## Listing fields

| Field                            | Content                                                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                             | Misha Browser                                                                                                                                                                                                   |
| Summary                          | The manifest's `description`: "Connect local AI agents to your browser and signed-in Slack through the Misha app on your Mac." The build fails on one longer than Chrome's 132 characters.                      |
| Description                      | [`listing.md`](listing.md)                                                                                                                                                                                      |
| Category                         | Productivity, or the dashboard's nearest equivalent                                                                                                                                                             |
| Language                         | English                                                                                                                                                                                                         |
| Mature content                   | No                                                                                                                                                                                                              |
| Homepage                         | https://dumdummisha.ai                                                                                                                                                                                          |
| Support                          | https://docs.dumdummisha.ai/operate/troubleshooting                                                                                                                                                             |
| Privacy policy                   | https://docs.dumdummisha.ai/privacy                                                                                                                                                                             |
| Store icon                       | `src/extension/icons/misha-128.png`: 128 by 128 pixels, its artwork within a centred 96-pixel square with 16 transparent pixels on each side (`pnpm run render-icons` renders it so, and `pnpm test` checks it) |
| Screenshots                      | To do, see below                                                                                                                                                                                                |
| Small promo tile, marquee, video | Left out: optional, and not needed for an unlisted first listing                                                                                                                                                |
| Visibility                       | Unlisted. Anyone with the listing's address can install it; Misha's invites, not the listing, decide who can use the Misha app.                                                                                 |

## Privacy fields

The dashboard's privacy fields take the text of [`../store-permissions.md`](../store-permissions.md), which `pnpm run disclosures` generates from [`../store-disclosures.json`](../store-disclosures.json) and the manifest. Edit those sources, never the generated file; `pnpm test` fails while it is stale.

| Field                     | Section of `store-permissions.md`                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Single purpose            | Single purpose, verbatim                                                                                                   |
| Permission justifications | Permission justifications: one section per permission, host permission and content script                                  |
| Remote code               | Remote code: No                                                                                                            |
| Data usage                | Data usage: all nine categories handled, with what each covers, and the three certifications and the Limited Use statement |

## Review instructions

[`review-instructions.md`](review-instructions.md) holds the text for the reviewers, with the places the owner fills in before submission.

## Screenshots to do

Chrome takes one to five screenshots, 1280 by 800 or 640 by 400 pixels, full bleed with square corners. Two are planned, taken by hand with made-up accounts and content only:

- [ ] A browser action and its result: an agent asked to read or act on an ordinary web page, with the page and the change it made.
- [ ] Slack: a message arriving in the Misha app from a signed-in Slack tab, or a reply the app sent there.

The Misha app's own screenshots can show its setup, but they do not replace these two, which show the extension at work.

## Owner decisions before submission

- The publisher account: display name, contact email verification, 2-Step Verification, trader or non-trader status with the public details it requires, and the regions to list in.
- The reviewer's Misha build, invite and test accounts named in `review-instructions.md`.
- Approval to create the store item and upload the archive, then separately to submit it for review.
