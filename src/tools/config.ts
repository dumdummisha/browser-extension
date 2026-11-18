// Above the extension's own 10-second page-load wait, so a slow load comes back as a result, not a timeout.
export const REQUEST_TIMEOUT_MS = 20_000

// Called by absolute path, so the spawning shell's PATH cannot change which binary runs.
export const OPEN_BIN = '/usr/bin/open'
export const OPEN_TIMEOUT_MS = 10_000

export const ACTIVATE_TIMEOUT_MS = 3_000
export const FIELD_FOCUS_TIMEOUT_MS = 1_000
export const FIELD_SETTLE_INTERVAL_MS = 100
export const FIELD_SETTLE_TIMEOUT_MS = 2_000
export const FOCUS_POLL_INTERVAL_MS = 100
export const LINE_BREAK = /\r?\n/u

// How long the pointer glides to a target; quick, but a person can still follow it.
export const POINTER_GLIDE_MS = 150
export const POINTER_TIMEOUT_MS = 1_500
export const POINTER_POLL_INTERVAL_MS = 50
export const POINT_LANDING_TOLERANCE_PX = 2

// A click or key press starts a navigation a moment after it lands, so the load check waits this long first; the
// extension then waits for the page to stop changing.
export const SETTLE_DELAY_MS = 150

export const SCROLL_SETTLE_MS = 400
export const SCROLL_VIEWPORT_FRACTION = 0.8

export const VIEWPORT_SNAPSHOT_MAX_CHARS = 8_000
export const PAGE_SNAPSHOT_MAX_CHARS = 30_000
// find and the change report scan the whole page but return only the lines that matter.
export const PAGE_SCAN_MAX_CHARS = 300_000
export const LISTED_CHANGES = 40
export const LISTED_MATCHES = 40
export const FIND_SECTION_LINES = 12

// A download waiting in the browser's save sheet: the sheet opens a moment after the download starts.
export const SAVE_DIALOG_DELAY_MS = 300
export const SAVE_DIALOG_TIMEOUT_MS = 5_000
export const DOWNLOAD_POLL_INTERVAL_MS = 200
// Below REQUEST_TIMEOUT_MS, so a long download comes back as still receiving, not as a timeout.
export const DOWNLOAD_TIMEOUT_MS = 15_000

export const NETWORK_DEFAULT_LAST = 20

export const WAIT_POLL_INTERVAL_MS = 250
export const WAIT_DEFAULT_SECONDS = 30
export const WAIT_MAX_SECONDS = 300

export const TAB_ID_ARG_DESCRIPTION =
  'Tab id from tab_list or tab_read. Defaults to the active tab of the browser window the user used last.'
export const REF_ARG_DESCRIPTION =
  'Element ref: the number in brackets in tab_read output, e.g. 12 for "[12] button". Refs stay valid while the ' +
  'element stays on the page.'
