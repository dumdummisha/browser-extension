export const MOUSE_MOVE_DURATION_MS = 300
// A drag's default pauses after the press and before the release: enough for Chromium's own drag and drop and for
// pointer drags. A drag that starts only after a long press, or a target that reacts to hovering, asks for more.
export const DRAG_HOLD_DEFAULT_MS = 10
export const DRAG_DWELL_DEFAULT_MS = 10
export const DRAG_PAUSE_MAX_MS = 10_000
export const DRAG_PATH_MAX_POINTS = 50

export const OSASCRIPT_BIN = '/usr/bin/osascript'
export const OPEN_BIN = '/usr/bin/open'
export const APP_SUBPROCESS_TIMEOUT_MS = 10_000
// Switching to another Space animates before the activated app reports itself frontmost.
export const APP_FOCUS_TIMEOUT_MS = 5_000
export const APP_FOCUS_POLL_INTERVAL_MS = 100
