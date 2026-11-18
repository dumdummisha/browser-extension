import { accessSync, constants as fsConstants, existsSync, linkSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { runSubprocess, stderrDetail } from '../module/subprocess.js'
import { hasContent, logWarning } from '../module/support.js'
import { errorMessage, isErrnoCode, PluginError } from '../module/tool.js'
import {
  CONVERT_ALLOWED_FFMPEG_FLAGS,
  CONVERT_ALLOWED_FILTERS,
  CONVERT_ALLOWED_OUTPUT_EXTENSIONS,
  CONVERT_FILTER_FLAGS,
  CONVERT_FORBIDDEN_ARG_SUBSTRINGS,
  CONVERT_MAX_COLLISION_RETRIES,
  CONVERT_MAX_PLAN_ARGS,
  CONVERT_PLAN_TIMEOUT_MS,
  CONVERT_PROBE_TIMEOUT_MS,
  DEFAULT_CONVERT_FFMPEG_TIMEOUT_MS,
  FFMPEG_TIMEOUT_VARIABLE,
  MAX_TIMER_MS,
  OPENCODE_NOT_FOUND_HINT,
  PLAN_AGENT,
} from './config.js'
import { FFMPEG_NOT_FOUND_HINT, ffmpegBinary, firstVideoStream, type MediaProbe, probeMedia } from './media.js'

export interface IVideoMetadata {
  // null for a container that has no duration, such as a still image.
  readonly durationSeconds: number | null
  // null for a file without a video stream, such as an audio file.
  readonly video: { readonly width: number; readonly height: number; readonly codec: string } | null
  readonly hasAudio: boolean
  readonly formatName: string
}

export interface IConvertVideoRequest {
  readonly source: string
  readonly instruction: string
  readonly model: string
  readonly directory: string
  readonly signal: AbortSignal
  readonly onProgress: (message: string) => void
}

export interface IConvertVideoResult {
  readonly inputPath: string
  readonly outputPath: string
  readonly summary: string
  readonly ffmpegArgs: string[]
  readonly metadata: IVideoMetadata
  readonly outputBytes: number
}

// The model's output-side args only: the service adds `-y -i <input>` and the output path itself.
export interface IConversionPlan {
  readonly args: string[]
  readonly outputExtension: string
  readonly summary: string
}

// The text parts of `opencode run --format json`, one JSON event per line.
const OpenCodeEventSchema = z.looseObject({
  type: z.string().optional(),
  part: z.looseObject({ text: z.string().optional() }).optional(),
})

// ffprobe prints a duration as seconds with a fractional part, such as 1.500000.
const PROBE_DURATION_PATTERN = /^\d+(?:\.\d+)?$/u

// A model only plans the ffmpeg args: a child agent asked to run ffmpeg itself editorializes, verifies or refuses,
// while emitting an arg vector is a task it does reliably.
export const convertVideo = async ({
  source,
  instruction,
  model,
  directory,
  signal,
  onProgress,
}: IConvertVideoRequest): Promise<IConvertVideoResult> => {
  onProgress('Validating input...')
  const ffmpegTimeoutMs = ffmpegTimeout()
  const inputPath = resolveReadableInput(source, directory)
  onProgress('Probing metadata...')
  const metadata = toVideoMetadata(inputPath, await probeMedia(inputPath, CONVERT_PROBE_TIMEOUT_MS, signal))
  onProgress('Planning conversion...')
  const plan = await planConversion(instruction, metadata, model, signal)
  validatePlan(plan)

  const outputDir = resolveWritableOutputDir(inputPath)
  const stem = basename(inputPath, extname(inputPath))
  // Beside the output, so the link commit stays on one filesystem; ffmpeg picks the muxer from the final extension.
  const tempPath = join(outputDir, `.${stem}.converted.partial-${process.pid}${plan.outputExtension}`)
  removePartialOutput(tempPath)
  const ffmpegArgs = ['-y', '-i', inputPath, ...plan.args, tempPath]
  onProgress('Running ffmpeg...')

  try {
    await runFfmpeg(ffmpegArgs, ffmpegTimeoutMs, signal)
    requireNonEmptyOutput(tempPath)
    const outputPath = commitOutput(tempPath, outputDir, stem, plan.outputExtension)
    const outputBytes = statSync(outputPath).size

    return { inputPath, outputPath, summary: plan.summary, ffmpegArgs, metadata, outputBytes }
  } finally {
    removePartialOutput(tempPath)
  }
}

// existsSync and statSync succeed on a file macOS TCC blocks (Desktop, Documents, Downloads); only accessSync(R_OK)
// fails for it.
const resolveReadableInput = (source: string, directory: string): string => {
  const path = isAbsolute(source) ? source : resolve(directory, source)
  if (!existsSync(path)) {
    throw new PluginError(`Input file not found: "${path}".`, 'NOT_FOUND')
  }

  if (!statSync(path).isFile()) {
    throw new PluginError(`Input path is not a file: "${path}".`, 'VALIDATION_ERROR')
  }

  try {
    accessSync(path, fsConstants.R_OK)
  } catch {
    throw new PluginError(
      `Cannot read "${path}" - macOS is blocking access to this location (TCC). ` +
        'Move the file to a directory the app running this tool server can read (for example inside your ' +
        'project folder) and try again. This tool will not copy files out of protected locations for you.',
      'FORBIDDEN'
    )
  }

  return path
}

// An absent duration or video stream is a fact about the file; a probe that names no container, no stream to convert,
// a duration that is not a number of seconds or a video stream without a usable size or codec describes nothing ffmpeg
// could be planned for.
export const toVideoMetadata = (inputPath: string, probe: MediaProbe): IVideoMetadata => {
  const { streams, format } = probe
  const video = videoOf(inputPath, firstVideoStream(probe))
  const hasAudio = streams.some((stream) => stream.codec_type === 'audio')
  if (!format.format_name?.trim()) {
    throw new PluginError(`ffprobe reported no container format for "${inputPath}".`, 'VALIDATION_ERROR')
  }

  if (video === null && !hasAudio) {
    throw new PluginError(`"${inputPath}" has no video or audio stream to convert.`, 'VALIDATION_ERROR')
  }

  return {
    durationSeconds: durationOf(inputPath, format.duration),
    video,
    hasAudio,
    formatName: format.format_name,
  }
}

const durationOf = (inputPath: string, duration: string | undefined): number | null => {
  if (duration === undefined) {
    return null
  }

  const seconds = Number(duration)
  if (!PROBE_DURATION_PATTERN.test(duration) || !Number.isFinite(seconds)) {
    throw new PluginError(
      `ffprobe reported the duration "${duration}" for "${inputPath}", which is not a number of seconds.`,
      'VALIDATION_ERROR'
    )
  }

  return seconds
}

const videoOf = (inputPath: string, stream: MediaProbe['streams'][number] | undefined): IVideoMetadata['video'] => {
  if (stream === undefined) {
    return null
  }

  const { width, height, codec_name: codec } = stream
  if (!isPositiveInteger(width) || !isPositiveInteger(height) || !codec?.trim()) {
    throw new PluginError(
      `ffprobe reported no usable size or codec for the video stream of "${inputPath}".`,
      'VALIDATION_ERROR'
    )
  }

  return { width, height, codec }
}

const isPositiveInteger = (value: number | undefined): value is number =>
  value !== undefined && Number.isInteger(value) && value > 0

// CONVERT_FFMPEG_TIMEOUT_MS, when set, bounds the ffmpeg run instead of the default.
const ffmpegTimeout = (): number => {
  const value = process.env[FFMPEG_TIMEOUT_VARIABLE]
  if (value === undefined) {
    return DEFAULT_CONVERT_FFMPEG_TIMEOUT_MS
  }

  const timeoutMs = Number(value)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
    throw new PluginError(
      `${FFMPEG_TIMEOUT_VARIABLE} must be a whole number of milliseconds from 1 to ${MAX_TIMER_MS}, not "${value}".`,
      'VALIDATION_ERROR'
    )
  }

  return timeoutMs
}

// One prompt answered by OpenCode's PLAN_AGENT, which has no tools, on a private server (--standalone) instead of the
// shared background service.
const planConversion = async (
  instruction: string,
  metadata: IVideoMetadata,
  model: string,
  signal: AbortSignal
): Promise<IConversionPlan> => {
  const opencode = opencodeBinary()
  const { stdout, stderr, exitCode } = await runSubprocess({
    command: opencode,
    args: [
      'run',
      '--standalone',
      '--format',
      'json',
      buildPlanPrompt(instruction, metadata),
      '--model',
      model,
      '--agent',
      PLAN_AGENT,
    ],
    timeoutMs: CONVERT_PLAN_TIMEOUT_MS,
    label: opencode,
    notFoundHint: OPENCODE_NOT_FOUND_HINT,
    signal,
  })
  if (exitCode !== 0) {
    throw new PluginError(
      `Plan subprocess exited with code ${exitCode}. ${planStderrDetail(stderr)}`,
      'EXTERNAL_API_ERROR'
    )
  }

  const reply = stdout.split('\n').map(planText).join('').trim()
  if (reply.length === 0) {
    throw new PluginError(`Plan model "${model}" returned no text. ${planStderrDetail(stderr)}`, 'EXTERNAL_API_ERROR')
  }

  return parsePlan(reply)
}

const opencodeBinary = (): string => process.env.OPENCODE_BIN ?? 'opencode'

// opencode writes the provider error to stderr, so its tail makes a model or auth failure actionable; its plugins'
// start-up lines are not part of the error.
const planStderrDetail = (stderr: string): string =>
  stderrDetail(
    stderr
      .split('\n')
      .filter((line) => !line.includes('Plugin initialized') && !line.includes('not configured'))
      .join('\n')
  )

// A line that is not a JSON text event (a start-up line, another event) carries no text of the reply.
const planText = (line: string): string => {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) {
    return ''
  }

  const event = OpenCodeEventSchema.safeParse(parseJsonOrNull(trimmed))
  if (!event.success || event.data.type !== 'text') {
    return ''
  }

  return event.data.part?.text ?? ''
}

const parseJsonOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const buildPlanPrompt = (instruction: string, metadata: IVideoMetadata): string => {
  const { durationSeconds, video } = metadata
  const audioNote = metadata.hasAudio
    ? 'The input HAS an audio stream.'
    : 'The input has NO audio stream - do not emit any audio filter (-af) or audio options.'

  return (
    'You are an ffmpeg argument generator. Convert the user request into the ffmpeg ' +
    'arguments that go AFTER the input and BEFORE the output file.\n\n' +
    'STRICT RULES:\n' +
    '- Output ONLY a single JSON object, no prose, no markdown fences.\n' +
    '- Shape: {"args": string[], "outputExtension": string, "summary": string}.\n' +
    '- "args" is the ffmpeg ARGUMENT VECTOR (each token a separate array element) for everything ' +
    'between the input and the output path. Do NOT include the input path, the output path, ' +
    '`ffmpeg`, `-i`, or `-y` - those are added for you.\n' +
    '- "outputExtension" is the output container/format extension including the dot ' +
    `(one of: ${CONVERT_ALLOWED_OUTPUT_EXTENSIONS.join(', ')}).\n` +
    '- "summary" is one short human sentence describing what the conversion does.\n' +
    '- For a speed change of factor N: video uses -filter:v "setpts=PTS/N"; when audio is present, ' +
    'keep A/V in sync with an -filter:a "atempo=..." chain. atempo accepts 0.5-2.0 per stage, so for ' +
    'N greater than 2 chain stages whose product is N (e.g. 3x -> "atempo=2.0,atempo=1.5", 4x -> ' +
    '"atempo=2.0,atempo=2.0").\n' +
    '- To scale to a target height H preserving aspect ratio and keeping dimensions even: ' +
    '-vf "scale=-2:H".\n' +
    '- Combine scale and speed into a single -vf/-filter:v chain when both are requested.\n' +
    '- Prefer widely-compatible codecs (h264 + aac for mp4/mov) unless the request says otherwise.\n' +
    `- ${audioNote}\n\n` +
    `INPUT METADATA: duration=${durationSeconds === null ? 'none' : `${durationSeconds.toFixed(2)}s`}, ` +
    `width=${video?.width ?? 'none'}, height=${video?.height ?? 'none'}, ` +
    `videoCodec=${video?.codec ?? 'none'}, hasAudio=${metadata.hasAudio}, ` +
    `format=${metadata.formatName}\n\n` +
    `USER REQUEST: ${instruction}`
  )
}

// Models still wrap the JSON in a fence or add a sentence, so the plan is the span from the first { to the last }.
export const parsePlan = (reply: string): IConversionPlan => {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new PluginError(`Plan model did not return a JSON object. Got: ${truncate(reply, 300)}`, 'EXTERNAL_API_ERROR')
  }

  const json = reply.slice(start, end + 1)

  return toPlan(parseJsonOrThrow(json, `Plan model returned malformed JSON. Got: ${truncate(json, 300)}`))
}

const toPlan = (parsed: unknown): IConversionPlan => {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PluginError('Plan JSON was not an object.', 'EXTERNAL_API_ERROR')
  }

  const { args, outputExtension, summary } = parsed as Record<string, unknown>
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === 'string')) {
    throw new PluginError('Plan "args" must be an array of strings.', 'EXTERNAL_API_ERROR')
  }

  if (typeof outputExtension !== 'string') {
    throw new PluginError('Plan "outputExtension" must be a string.', 'EXTERNAL_API_ERROR')
  }

  if (typeof summary !== 'string' || summary.trim().length === 0) {
    throw new PluginError('Plan "summary" must be a non-empty string.', 'EXTERNAL_API_ERROR')
  }

  const extension = outputExtension.toLowerCase()

  return {
    args,
    outputExtension: extension.startsWith('.') ? extension : `.${extension}`,
    summary: summary.trim(),
  }
}

export const validatePlan = ({ outputExtension, args }: IConversionPlan): void => {
  if (!CONVERT_ALLOWED_OUTPUT_EXTENSIONS.includes(outputExtension)) {
    throw new PluginError(
      `Plan requested unsupported output "${outputExtension}". ` +
        `Allowed: ${CONVERT_ALLOWED_OUTPUT_EXTENSIONS.join(', ')}.`,
      'VALIDATION_ERROR'
    )
  }

  if (args.length > CONVERT_MAX_PLAN_ARGS) {
    throw new PluginError(
      `Plan produced ${args.length} args, over the ${CONVERT_MAX_PLAN_ARGS} limit.`,
      'VALIDATION_ERROR'
    )
  }

  const tokens = args.values()
  for (const flag of tokens) {
    const arity = CONVERT_ALLOWED_FFMPEG_FLAGS[flag.toLowerCase()]
    if (arity === undefined) {
      throw new PluginError(
        `Plan arg "${flag}" is not an allowed ffmpeg flag. The model may only emit known transcoding ` +
          'flags (the service owns all input/output).',
        'VALIDATION_ERROR'
      )
    }

    if (arity === 'value') {
      const next = tokens.next()
      if (next.done) {
        throw new PluginError(`Plan flag "${flag}" is missing its value.`, 'VALIDATION_ERROR')
      }

      validateFlagValue(flag, next.value)
    }
  }
}

const validateFlagValue = (flag: string, value: string): void => {
  const lowered = value.toLowerCase()
  const smuggled = CONVERT_FORBIDDEN_ARG_SUBSTRINGS.find((needle) => lowered.includes(needle))
  if (smuggled !== undefined) {
    throw new PluginError(`Plan value "${value}" contains a forbidden reference ("${smuggled}").`, 'VALIDATION_ERROR')
  }

  if (!CONVERT_FILTER_FLAGS.includes(flag.toLowerCase())) {
    return
  }

  for (const name of value.split(/[,;]/u).map(filterName)) {
    if (name.length > 0 && !CONVERT_ALLOWED_FILTERS.includes(name)) {
      throw new PluginError(
        `Plan uses filter "${name}", which is not allowed. Allowed filters: ${CONVERT_ALLOWED_FILTERS.join(', ')}.`,
        'VALIDATION_ERROR'
      )
    }
  }
}

// A filter is `name=args` or `name`, optionally wrapped in stream labels such as [0:v] or [out].
const filterName = (filter: string): string => {
  const withoutLabels = filter.replace(/\[[^\]]*\]/gu, '').trim()
  const eq = withoutLabels.indexOf('=')

  return (eq === -1 ? withoutLabels : withoutLabels.slice(0, eq)).trim().toLowerCase()
}

// Not the recursive removeTempPath: this path sits in the user's folder, so only a file there is removed.
const removePartialOutput = (path: string): void => {
  try {
    rmSync(path, { force: true })
  } catch (error) {
    logWarning('VideoConvert', `Failed to delete temp file "${path}": ${errorMessage(error)}`)
  }
}

const runFfmpeg = async (args: string[], timeoutMs: number, signal: AbortSignal): Promise<void> => {
  const ffmpeg = ffmpegBinary()

  const { stderr, exitCode } = await runSubprocess({
    command: ffmpeg,
    args,
    timeoutMs,
    label: ffmpeg,
    notFoundHint: FFMPEG_NOT_FOUND_HINT,
    signal,
  })

  if (exitCode !== 0) {
    throw new PluginError(`ffmpeg failed (exit ${exitCode}). ${stderrDetail(stderr)}`, 'EXTERNAL_API_ERROR')
  }
}

const requireNonEmptyOutput = (path: string): void => {
  if (!hasContent(path)) {
    throw new PluginError('ffmpeg exited successfully but produced no output file.', 'EXTERNAL_API_ERROR')
  }
}

const resolveWritableOutputDir = (inputPath: string): string => {
  const dir = dirname(inputPath)

  try {
    accessSync(dir, fsConstants.W_OK)
  } catch {
    throw new PluginError(
      `Cannot write into "${dir}" - the directory is not writable (this can be macOS TCC). ` +
        'Move the input to a writable location and try again.',
      'FORBIDDEN'
    )
  }

  return dir
}

// linkSync fails with EEXIST rather than overwrite, so a concurrent run can never clobber a name this one took.
const commitOutput = (tempPath: string, outputDir: string, stem: string, outputExtension: string): string => {
  for (let counter = 1; counter <= CONVERT_MAX_COLLISION_RETRIES; counter += 1) {
    const candidate = join(outputDir, `${stem}.converted${counter === 1 ? '' : `.${counter}`}${outputExtension}`)

    try {
      linkSync(tempPath, candidate)

      return candidate
    } catch (error) {
      if (!isErrnoCode(error, 'EEXIST')) {
        throw new PluginError(`Failed to write output file: ${errorMessage(error)}`, 'INTERNAL_ERROR', error)
      }
    }
  }

  throw new PluginError(
    `Could not find a free output name after ${CONVERT_MAX_COLLISION_RETRIES} attempts in "${outputDir}".`,
    'INTERNAL_ERROR'
  )
}

const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}...`)

const parseJsonOrThrow = (text: string, message: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    throw new PluginError(message, 'EXTERNAL_API_ERROR')
  }
}
