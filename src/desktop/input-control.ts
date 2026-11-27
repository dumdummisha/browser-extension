import { lines, MouseButton, pixels, Session, type Key, type LogicalPoint, type Modifier, type Monitor } from 'robot-ts'
import { loadOnce, sleep, tempPath } from '../module/support.js'
import { errorMessage, PluginError, requireMacOs } from '../module/tool.js'
import { MOUSE_MOVE_DURATION_MS } from './config.js'
import { keyFromName, modifierKey, modifiersFromNames } from './key-map.js'

// The monitor's physicalBounds equal the image size, which grounding needs to map coordinates back to pixels.
interface ICaptureResult {
  path: string
  width: number
  height: number
  monitor: Monitor
}

const MOUSE_BUTTONS = { left: MouseButton.Left, right: MouseButton.Right, middle: MouseButton.Middle }

type MouseButtonName = keyof typeof MOUSE_BUTTONS

// path holds the points the pointer passes through, in order, on its way to the target; holdMs is how long the
// button stays down before the pointer moves, dwellMs how long the pointer rests on the target before the release.
interface IDragGesture {
  to: LogicalPoint
  button: MouseButtonName
  path: readonly LogicalPoint[]
  modifiers: readonly Modifier[]
  holdMs: number
  dwellMs: number
}

// One robot-ts Session backs input and capture for the module's lifetime. Creating it is the permission check, so
// a failed creation is not kept and a call after the user grants the permissions creates it again.
export class InputControlService {
  private readonly session = loadOnce(createSession)

  public readonly moveMouse = async (
    point: LogicalPoint,
    isSmooth: boolean,
    durationMs = MOUSE_MOVE_DURATION_MS
  ): Promise<void> => {
    const { mouse } = await this.ensureSession()

    await (isSmooth ? mouse.moveSmooth(point, { durationMs }) : mouse.move(point))
  }

  public readonly click = async (
    button: MouseButtonName,
    isDoubleClick: boolean,
    modifiers: readonly Modifier[] = []
  ): Promise<void> => {
    const { mouse } = await this.ensureSession()

    await this.withModifiers(modifiers, () =>
      isDoubleClick ? mouse.doubleClick(MOUSE_BUTTONS[button]) : mouse.click(MOUSE_BUTTONS[button])
    )
  }

  public readonly currentMousePosition = async (): Promise<LogicalPoint> => {
    const { mouse } = await this.ensureSession()

    return mouse.position()
  }

  // The button goes down where the pointer is and comes up on the target, with the modifiers held around the whole
  // gesture, so a Shift-drag constrains and an Option-drag duplicates. The button is released even when a move fails.
  public readonly drag = async ({ to, button, path, modifiers, holdMs, dwellMs }: IDragGesture): Promise<void> => {
    const { mouse } = await this.ensureSession()

    await this.withModifiers(modifiers, async () => {
      await mouse.press(MOUSE_BUTTONS[button])

      try {
        await sleep(holdMs)

        for (const point of [...path, to]) {
          await mouse.moveSmooth(point, { durationMs: MOUSE_MOVE_DURATION_MS })
        }

        await sleep(dwellMs)
      } finally {
        await mouse.release(MOUSE_BUTTONS[button])
      }
    })
  }

  // The modifier keys go down before the action and come up after it in reverse order, even when it fails. Every key
  // pressed is released even when releasing another failed, since a modifier left down changes every later input; a
  // release that failed is reported, with the action's own error when there was one.
  public readonly withModifiers = async <TResult>(
    modifiers: readonly Modifier[],
    action: () => Promise<TResult>
  ): Promise<TResult> => {
    const { keyboard } = await this.ensureSession()
    const pressed: { modifier: Modifier; key: Key }[] = []
    let outcome: { isOk: true; value: TResult } | { isOk: false; error: unknown }

    try {
      for (const modifier of modifiers) {
        const key = modifierKey(modifier)
        await keyboard.press(key)
        pressed.push({ modifier, key })
      }

      outcome = { isOk: true, value: await action() }
    } catch (error) {
      outcome = { isOk: false, error }
    }

    const stuck: string[] = []

    for (const { modifier, key } of pressed.toReversed()) {
      await keyboard.release(key).catch((error: unknown) => {
        stuck.push(`${modifier} (${errorMessage(error)})`)
      })
    }

    if (stuck.length > 0) {
      const after = outcome.isOk ? '' : ` after the action failed (${errorMessage(outcome.error)})`

      throw new PluginError(
        `Could not release the modifier keys ${stuck.join(', ')}${after}, so the system may still treat them as ` +
          'held. Ask the user to press and release them on the keyboard before any further input.',
        'INTERNAL_ERROR',
        outcome.isOk ? undefined : outcome.error
      )
    }

    if (!outcome.isOk) {
      throw outcome.error
    }

    return outcome.value
  }

  public readonly scroll = async (amount: number, unit: 'lines' | 'pixels', horizontal: number): Promise<void> => {
    const { mouse } = await this.ensureSession()

    await mouse.scroll(unit === 'pixels' ? pixels(amount, horizontal) : lines(amount, horizontal))
  }

  public readonly typeText = async (text: string): Promise<void> => {
    const { keyboard } = await this.ensureSession()

    await keyboard.typeText(text)
  }

  public readonly pressKey = async (keyName: string, modifierNames: readonly string[]): Promise<void> => {
    const { keyboard } = await this.ensureSession()

    await keyboard.tap(keyFromName(keyName), modifiersFromNames(modifierNames))
  }

  // The caller deletes the file.
  public readonly captureScreen = async (): Promise<ICaptureResult> => {
    const { screen } = await this.ensureSession()
    const monitor = await screen.primaryMonitor()

    const image = await screen.captureMonitor(monitor.id).catch((error: unknown) => {
      throw new PluginError(
        `Screen capture failed in ${process.execPath}. macOS returns no image when the binary running this tool ` +
          'server has no Screen Recording permission, even while mouse and keyboard work, since Accessibility is a ' +
          'separate grant. A tool server started by a worker can run a different node binary than the one started ' +
          'from a terminal (a version manager puts its real binary on PATH). Grant that binary Screen Recording in ' +
          'System Settings > Privacy & Security > Screen & System Audio Recording.',
        'FORBIDDEN',
        error
      )
    })

    const path = tempPath('screen', '.png')
    await image.savePng(path)

    return { path, width: image.width, height: image.height, monitor }
  }

  private readonly ensureSession = (): Promise<Session> => {
    requireMacOs('Input control')

    return this.session.load()
  }
}

// Both permissions up front: requesting only input would let a capture fail later in the session.
const createSession = async (): Promise<Session> => {
  try {
    return await Session.create({ requireInputPermission: true, requireCapturePermission: true })
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : ''

    throw new PluginError(
      'Could not start input control. macOS requires two permissions for the app that runs this tool server (the ' +
        'terminal, editor or desktop app running Claude Code or OpenCode): ' +
        'Accessibility (for mouse/keyboard control) and Screen Recording (for screenshots). ' +
        'Grant both in System Settings > Privacy & Security > Accessibility and > Screen Recording, ' +
        `then fully quit and reopen that app so the permissions take effect.${detail}`,
      'FORBIDDEN',
      error
    )
  }
}
