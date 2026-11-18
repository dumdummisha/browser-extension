import { z } from 'zod'
import { MarkdownBuilder } from '../module/markdown.js'
import { formatBytes } from '../module/support.js'
import type { IToolDefinition } from '../module/tool.js'
import { CONVERT_PLAN_MODEL, PLAN_AGENT } from './config.js'
import { convertVideo, type IConvertVideoResult, type IVideoMetadata } from './video-convert.js'

const input = z.object({
  source: z
    .string()
    .describe(
      'Local path to the input video/media file. Resolve it to a concrete path first (e.g. from a ' +
        'directory listing) - do NOT pass a vague description. The file must be in a location the ' +
        'app running this tool server can read: macOS blocks Desktop/Documents/Downloads (TCC), so a file ' +
        'there will hard-fail with a message to move it. Prefer a path inside a project folder.'
    ),
  instruction: z
    .string()
    .describe(
      'Natural-language description of the conversion, e.g. "1080p mp4 at 3x speed", "convert to gif", ' +
        '"extract audio as mp3", "compress and scale to 720p", "make a webp thumbnail from the first frame". ' +
        'Be specific about target format, resolution, and speed.'
    ),
  model: z
    .string()
    .optional()
    .describe(`Model used to translate the instruction into ffmpeg arguments. Defaults to ${CONVERT_PLAN_MODEL}.`),
})

export const convertVideoTool: IToolDefinition<typeof input> = {
  description:
    'Convert a local video/media file per a natural-language instruction (e.g. "1080p mp4 at 3x speed", ' +
    '"convert to gif", "extract audio to mp3"). It probes the input with ffprobe, asks a model to translate ' +
    'your request into an ffmpeg argument vector, then runs ffmpeg itself and writes the result NEXT TO the ' +
    'input file with a collision-safe ".converted" name. The model only generates the ffmpeg args - this tool ' +
    'executes them, so the conversion is deterministic and never runs arbitrary shell.\n\n' +
    'macOS-only concern: the input must be readable by the app running this tool server. Files on the Desktop, ' +
    'in Documents, or in Downloads are blocked by macOS privacy (TCC) and will hard-fail with a message asking ' +
    'you to move the file to a readable location (it will NOT copy the file for you). Requires ffmpeg/ffprobe ' +
    `on PATH, and OpenCode with an agent named ${PLAN_AGENT} that has no tools, which plans the arguments. Defaults ` +
    `the plan model to ${CONVERT_PLAN_MODEL}.`,
  input,
  execute: async ({ source, instruction, model = CONVERT_PLAN_MODEL }, { directory, signal, progress }) =>
    formatConversion(await convertVideo({ source, instruction, model, directory, signal, onProgress: progress })),
}

const formatConversion = ({
  inputPath,
  outputPath,
  outputBytes,
  summary,
  metadata,
  ffmpegArgs,
}: IConvertVideoResult): string =>
  MarkdownBuilder.create()
    .heading('Video converted', 2)
    .field('Input', inputPath)
    .field('Output', outputPath)
    .field('Size', formatBytes(outputBytes))
    .field('What', summary)
    .field('Source', formatSource(metadata))
    .blank()
    .text('**ffmpeg args:**')
    .codeBlock(ffmpegArgs.join(' '), 'text')
    .build()

const formatSource = ({ durationSeconds, video, hasAudio }: IVideoMetadata): string =>
  [
    ...(video === null ? [] : [`${video.width}x${video.height}`]),
    durationSeconds === null ? 'no duration' : `${durationSeconds.toFixed(1)}s`,
    video?.codec ?? 'no video',
    hasAudio ? 'has audio' : 'no audio',
  ].join(', ')
