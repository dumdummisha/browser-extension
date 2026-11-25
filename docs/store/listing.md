# Store description

The text for the listing's description field, from the line below the rule.

---

Misha Browser connects AI agents that run on your own Mac to the browser you already use, signed in as you.

It works through a small program on your Mac, its native host, which the browser starts and which passes messages between the extension and the agents on the same Mac. The extension has no server of its own. It serves two uses:

- The Misha app, a Mac companion that needs an invite, carries Slack through it: the extension reads new messages in your signed-in Slack tab and makes a fixed list of Slack calls there for the app. This transport runs on its own while the app is connected, not only when you ask for something.
- Agents such as Claude Code or OpenCode, through Misha Browser's MCP server, read pages and act in your tabs when you ask them: they read a page's text and controls, take screenshots, click, type, scroll and open or close tabs, as you.

While it runs, the extension also records the fetch and XHR requests every tab sends, with credentials redacted by name and pattern, so an agent can inspect a page's traffic when you ask. On Slack's pages it compares the requests it sends with Slack's own, keeping only listed fields.

What the extension reads goes to the agent on your Mac that asked for it, and from there to whatever that agent sends it to, usually the model provider the agent uses. Treat what you let an agent read in your browser as you would anything else you give that agent.

Setup: Misha Browser runs in Chrome or Brave on macOS. Install the native host with the Misha app (Set up page) or from the source repository, then open the browser with the extension enabled. Reload any Slack tab that was open before.

- Source code: https://github.com/dumdummisha/browser-extension
- Getting started: https://docs.dumdummisha.ai/start/get-started
- Permissions, and what each one allows: https://docs.dumdummisha.ai/reference/permissions
- Privacy policy: https://docs.dumdummisha.ai/privacy
