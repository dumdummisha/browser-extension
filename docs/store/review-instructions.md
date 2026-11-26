# Review instructions

The text for the dashboard's test instructions, from the line below the rule. The owner replaces each bracketed item with the real build, invite and test accounts before submitting; this repository holds no credential, and a reviewer gets a valid invite like anyone else.

Submit only after unit S has adopted the store item's key and id. Until then step 4 cannot connect: a copy installed from the store has the store item's id, and the native host's `allowed_origins` holds only the development id.

---

Misha Browser connects agents on the user's own Mac to their browser through a native messaging host on that Mac. Without the host, the extension loads but has nothing to talk to, so the review needs a Mac with the Misha app.

1. On a Mac running a recent macOS, download the signed Misha app from [link to the reviewer's build] and open it.
2. Activate it with the invite [reviewer invite], following the app's first screens.
3. On the app's **Get started** page (or **Extensions**), click **Install the helper**. This writes the native host's launcher and registers it with Chrome for this extension only.
4. Install Misha Browser from this listing. Chrome starts the native host as soon as the extension runs; [where the app shows the browser as connected].
5. Browser use: the app's window has no place to ask an agent, and its Slack clone gets no browser tools. In the app, open **Extensions**, click **Open the catalogue** and add **Browser control**. Then start a Claude Code or OpenCode session on the same Mac and ask it to read an ordinary page, for example "Open https://example.com and tell me its heading." The agent opens the page and answers with its heading.
6. Slack use: sign in to [authorized Slack test workspace] as [test account] in a Chrome tab at https://app.slack.com, then [the app's steps to use that Slack account]. Post a message in a test channel: it appears in the app, and a reply sent from the app appears in the channel.

[If signing in to the app's test flow uses Google while the app's Google sign-in is in Testing, the reviewer's Google account must first be added as a test user: name it here.]

The extension loads no remote code. The native host passes messages that name a method and carry data, never code. The listing's privacy fields describe every permission and what data each use handles.
