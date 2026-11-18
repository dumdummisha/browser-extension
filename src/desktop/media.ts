import { z } from 'zod'
import { runSubprocess, stderrDetail } from '../module/subprocess.js'
import { PluginError } from '../module/tool.js'

// The media programs macos_convert_video starts, each by its name on PATH unless its environment variable names another
// one. Read on every call, so a variable set after the module loaded still counts.
export const ffmpegBinary = (): string => process.env.FFMPEG_BIN ?? 'ffmpeg'
export const ffprobeBinary = (): string => process.env.FFPROBE_BIN ?? 'ffprobe'

export const FFMPEG_NOT_FOUND_HINT = 'Install ffmpeg or set FFMPEG_BIN.'
const FFPROBE_NOT_FOUND_HINT = 'Install ffmpeg, which provides ffprobe, or set FFPROBE_BIN.'

const MediaProbeSchema = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string().optional(),
      codec_name: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    })
  ),
  format: z.object({ duration: z.string().optional(), format_name: z.string().optional() }),
})

export type MediaProbe = z.infer<typeof MediaProbeSchema>

// Every stream and the container of a media file.
export const probeMedia = async (path: string, timeoutMs: number, signal: AbortSignal): Promise<MediaProbe> => {
  const ffprobe = ffprobeBinary()
  const { stdout, stderr, exitCode } = await runSubprocess({
    command: ffprobe,
    args: ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    timeoutMs,
    label: ffprobe,
    notFoundHint: FFPROBE_NOT_FOUND_HINT,
    signal,
  })
  if (exitCode !== 0) {
    throw new PluginError(`ffprobe could not read "${path}". ${stderrDetail(stderr)}`, 'EXTERNAL_API_ERROR')
  }

  const parsed = MediaProbeSchema.safeParse(parseJson(stdout))
  if (!parsed.success) {
    throw new PluginError(
      `ffprobe returned an unexpected shape for "${path}": ${parsed.error.message}`,
      'EXTERNAL_API_ERROR'
    )
  }

  return parsed.data
}

export const firstVideoStream = ({ streams }: MediaProbe): MediaProbe['streams'][number] | undefined =>
  streams.find((stream) => stream.codec_type === 'video')

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    throw new PluginError('ffprobe returned output that was not valid JSON.', 'EXTERNAL_API_ERROR')
  }
}
