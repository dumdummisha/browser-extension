import { answerRelays, HELD_FRAMES_MAX, holdFrames } from '../service-worker/capture-handshake.js'
import { whatsappCapture } from '../service-worker/whatsapp-capture.js'
import { WHATSAPP_CORE_MODULES, whatsappInternalsOf } from '../service-worker/whatsapp-internals.js'

// The WhatsApp observer's entry, in the page's own world at document_start, before WhatsApp Web's scripts. It hands each
// relay of the extension one end of a private channel at once (capture-handshake.ts), so the relay's handshake at
// document_start finds it, and greets each with its token and its capture state. Once the window has loaded, it waits
// for the page's own module loader to define the core modules (no timer, so no interval or give-up time to source),
// builds the internals from the page's module system (whatsapp-internals.ts) and starts the capture
// (whatsapp-capture.ts), which reports its state on every change and each new message it reports. A command a relay
// posts goes to the capture, whose one answer goes back on that relay's port. It adds nothing to the page's window or
// document.
//
// Threat model (docs/security.md): scripts already running in the page are out of scope (U2-R17). They already hold the
// page's module system, and with it everything the observer can do; the observer holds no secret and no privilege of
// the extension. The built-ins taken at load (here and in the modules it bundles) keep what the observer reads the same
// when the page's scripts later replace one; they are not a boundary against such a script.
const { apply, get: valueAt } = Reflect
const { now } = Date
const { setTimeout: setTimer, clearTimeout: clearTimer } = window
const listen = EventTarget.prototype.addEventListener

// Made once, when the observer loads (U2-R26): the prepare's answer carries it, and the service worker hands a commit
// only to the document whose observer greeted with it.
const token = crypto.randomUUID()

// What the capture posts unasked goes to every relay: a new message held as a frame until a relay reports it taken, its
// state as it stands. Both are posted only after the capture starts, by which time the relays' links exist.
const post = (message: object): void => {
  if (valueAt(message, 'kind') === 'message') {
    relays.postFrame(message)
  } else {
    relays.postState(message)
  }
}

const capture = whatsappCapture(post, {
  now: () => now(),
  setTimer: (run, ms) => setTimer(run, ms),
  clearTimer: (timer) => {
    clearTimer(timer)
  },
  token,
})

// Every relay that asked gets a greeting with the token and the capture state as it stands, every new message no relay
// reported taken yet, and then each change and each new message.
const relays = answerRelays(
  document,
  () => ({ kind: 'greeting', token, capture: capture.state() }),
  holdFrames(HELD_FRAMES_MAX),
  capture.command
)

// The page's module system is its window.require and requireLazy, both there once the window loaded (design S.6). Either
// missing is the no-module-system drift. requireLazy calls back once the page defined the core modules, and the capture
// starts on internals that read the page's modules through window.require.
const startCapture = (): void => {
  const require: unknown = valueAt(window, 'require')
  const requireLazy: unknown = valueAt(window, 'requireLazy')
  if (typeof require !== 'function' || typeof requireLazy !== 'function') {
    capture.noModuleSystem()
    return
  }

  apply(requireLazy, window, [
    WHATSAPP_CORE_MODULES,
    () => {
      capture.start(whatsappInternalsOf((name) => apply(require, window, [name])))
    },
  ])
}

if (document.readyState === 'complete') {
  startCapture()
} else {
  apply(listen, window, ['load', startCapture, { once: true }])
}
