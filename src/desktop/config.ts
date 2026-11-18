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

export const CONVERT_PLAN_MODEL = 'openai/gpt-5.6-luna'
// The OpenCode agent that plans a conversion: one with no tools, which answers the prompt alone (README).
export const PLAN_AGENT = 'vision'
export const OPENCODE_NOT_FOUND_HINT = 'Install OpenCode (https://opencode.ai) or set OPENCODE_BIN.'
export const FFMPEG_TIMEOUT_VARIABLE = 'CONVERT_FFMPEG_TIMEOUT_MS'
// The longest delay a Node timer takes.
export const MAX_TIMER_MS = 2_147_483_647

export const CONVERT_PLAN_TIMEOUT_MS = 120_000
export const CONVERT_PROBE_TIMEOUT_MS = 30_000
export const DEFAULT_CONVERT_FFMPEG_TIMEOUT_MS = 30 * 60_000

export const CONVERT_ALLOWED_OUTPUT_EXTENSIONS: readonly string[] = [
  '.mp4',
  '.mov',
  '.webm',
  '.mkv',
  '.gif',
  '.mp3',
  '.m4a',
  '.wav',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
]

// An allowlist, because ffmpeg reads any bare token after the input as another output: only these flags, each
// with its arity ('value' consumes the next token), may appear. No I/O flag (-i, -f, -map, -filter_complex) is here.
export const CONVERT_ALLOWED_FFMPEG_FLAGS: Readonly<Record<string, 'value' | 'boolean'>> = {
  '-c': 'value',
  '-c:v': 'value',
  '-c:a': 'value',
  '-c:s': 'value',
  '-codec': 'value',
  '-codec:v': 'value',
  '-codec:a': 'value',
  '-vcodec': 'value',
  '-acodec': 'value',
  '-vf': 'value',
  '-af': 'value',
  '-filter:v': 'value',
  '-filter:a': 'value',
  '-filter': 'value',
  '-r': 'value',
  '-ar': 'value',
  '-ac': 'value',
  '-b': 'value',
  '-b:v': 'value',
  '-b:a': 'value',
  '-maxrate': 'value',
  '-minrate': 'value',
  '-bufsize': 'value',
  '-crf': 'value',
  '-q:v': 'value',
  '-q:a': 'value',
  '-qscale': 'value',
  '-qscale:v': 'value',
  '-qscale:a': 'value',
  '-preset': 'value',
  '-tune': 'value',
  '-profile:v': 'value',
  '-level': 'value',
  '-pix_fmt': 'value',
  '-s': 'value',
  '-aspect': 'value',
  '-g': 'value',
  '-keyint_min': 'value',
  '-ss': 'value',
  '-t': 'value',
  '-to': 'value',
  '-frames:v': 'value',
  '-frames:a': 'value',
  '-vframes': 'value',
  '-aframes': 'value',
  '-movflags': 'value',
  '-tag:v': 'value',
  '-tag:a': 'value',
  '-threads': 'value',
  '-loop': 'value',
  '-vsync': 'value',
  '-fps_mode': 'value',
  '-async': 'value',
  '-compression_level': 'value',
  '-start_number': 'value',
  '-gifflags': 'value',
  '-strict': 'value',
  '-map_metadata': 'value',
  '-metadata': 'value',
  '-disposition': 'value',
  '-bf': 'value',
  '-refs': 'value',
  '-sc_threshold': 'value',
  '-cpu-used': 'value',
  '-deadline': 'value',
  '-row-mt': 'value',
  '-an': 'boolean',
  '-vn': 'boolean',
  '-sn': 'boolean',
  '-dn': 'boolean',
  '-shortest': 'boolean',
  '-noautorotate': 'boolean',
  '-autorotate': 'boolean',
}

// A filter can read a file (movie=, subtitles=, ass=, drawtext textfile=) behind an allowed flag, so the values of
// these flags are split into filters and each name must be in CONVERT_ALLOWED_FILTERS.
export const CONVERT_FILTER_FLAGS: readonly string[] = ['-vf', '-af', '-filter:v', '-filter:a', '-filter']

export const CONVERT_ALLOWED_FILTERS: readonly string[] = [
  'scale',
  'setpts',
  'asetpts',
  'atempo',
  'fps',
  'crop',
  'pad',
  'format',
  'aformat',
  'aresample',
  'transpose',
  'hflip',
  'vflip',
  'setsar',
  'setdar',
  'eq',
  'fade',
  'afade',
  'volume',
  'null',
  'anull',
]

// ffmpeg reads `x://` and these prefixes as protocol inputs, so any value containing one rejects the plan.
export const CONVERT_FORBIDDEN_ARG_SUBSTRINGS: readonly string[] = ['://', 'concat:', 'file:', 'pipe:']

export const CONVERT_MAX_PLAN_ARGS = 40
export const CONVERT_MAX_COLLISION_RETRIES = 1000
