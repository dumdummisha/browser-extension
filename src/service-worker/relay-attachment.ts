import { z } from 'zod'

// How the service worker gives an open Slack tab a relay once the extension reloaded (background.ts attachRelays). It
// lives with the extension's modules the tests load, since the build replaces the compiled extension folder with its
// bundles.
//
// The tab is probed first, in the extension's isolated world, where its content scripts run: the probe answers the top
// document's origin, and whether a relay of this load of the extension runs there, from the mark a relay leaves in that
// world (relay.ts). chrome.scripting names the document it ran in, and the relay goes into that document only, never
// into whatever the tab shows by the time it is injected: the extension may script every site, so an injection by tab
// alone would put a relay into the page a Slack tab navigated to meanwhile.

// What the probe answers from a tab's top document.
export const RelayProbeSchema = z.strictObject({ origin: z.string(), hasRelay: z.boolean() })

export type RelayProbe = z.infer<typeof RelayProbeSchema>

// chrome.scripting serializes this function into the page's isolated world, so it uses nothing from the module's
// scope; runningKey is the mark a relay leaves there.
export const probeRelay = (runningKey: string): RelayProbe => ({
  origin: location.origin,
  hasRelay: Reflect.has(globalThis, runningKey),
})

// A tab's top document as the probe found it: the id chrome.scripting knows it by, and what the probe answered there.
export interface IProbedDocument {
  readonly documentId: string
  readonly probe: RelayProbe
}

export interface IRelayScripting {
  // The tab's top document, probed; null when the tab holds no document the extension can script.
  readonly probe: (tabId: number) => Promise<IProbedDocument | null>
  // Injects the relay into that document of the tab and no other; rejects when the document is gone or the injection
  // failed.
  readonly inject: (tabId: number, documentId: string) => Promise<void>
}

// Gives the tab's top document a relay when it is a page on slackOrigin without one. A document that is gone by the
// time the relay would go in, because the tab navigated, needs none: the page it shows now loaded after the extension
// did, so the manifest's scripts ran there if it is Slack's. An injection that fails while its document is still the
// one the tab shows rejects.
export const attachRelay = async (scripting: IRelayScripting, tabId: number, slackOrigin: string): Promise<void> => {
  const probed = await scripting.probe(tabId)
  if (probed === null || probed.probe.origin !== slackOrigin || probed.probe.hasRelay) {
    return
  }

  try {
    await scripting.inject(tabId, probed.documentId)
  } catch (error) {
    const shown = await scripting.probe(tabId)
    if (shown?.documentId === probed.documentId) {
      throw error
    }
  }
}
