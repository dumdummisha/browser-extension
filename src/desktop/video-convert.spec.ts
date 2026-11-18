import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type IConversionPlan, parsePlan, toVideoMetadata, validatePlan } from './video-convert.js'

const plan = (args: string[], outputExtension = '.mp4'): IConversionPlan => ({
  args,
  outputExtension,
  summary: 'Convert video',
})

const rejectsWith = (args: string[], message: RegExp, outputExtension?: string): void => {
  assert.throws(() => validatePlan(plan(args, outputExtension)), { name: 'PluginError', message })
}

describe('[desktop] Video convert - plan allowlist', () => {
  it('should accept a speed and scale plan built from allowed flags and filters', () => {
    // Act + Assert
    validatePlan(
      plan([
        '-filter:v',
        '[0:v]scale=-2:1080,setpts=PTS/3[out]',
        '-filter:a',
        'atempo=2.0,atempo=1.5',
        '-c:v',
        'libx264',
        '-an',
      ])
    )
  })

  it('should reject an output extension outside the allowed list', () => {
    // Act + Assert
    rejectsWith([], /^Plan requested unsupported output "\.exe"\. Allowed: \.mp4, /u, '.exe')
  })

  it('should reject a plan with more args than the limit', () => {
    // Act + Assert
    rejectsWith(
      Array.from({ length: 41 }, () => '-an'),
      /^Plan produced 41 args, over the 40 limit\.$/u
    )
  })

  for (const flag of ['-i', '-f', '-map', '-filter_complex', 'second-output.mp4']) {
    it(`should reject the arg ${flag}, which is not an allowed flag`, () => {
      // Act + Assert
      rejectsWith([flag, 'x'], new RegExp(`^Plan arg "${flag}" is not an allowed ffmpeg flag\\.`, 'u'))
    })
  }

  it('should match a flag regardless of case', () => {
    // Act + Assert
    validatePlan(plan(['-C:V', 'libx264']))
  })

  it('should reject a value flag that is missing its value', () => {
    // Act + Assert
    rejectsWith(['-c:v'], /^Plan flag "-c:v" is missing its value\.$/u)
  })

  it('should not let a boolean flag take the next token as its value', () => {
    // Act + Assert
    rejectsWith(['-an', 'libx264'], /^Plan arg "libx264" is not an allowed ffmpeg flag\./u)
  })

  for (const value of ['http://example.test/x.mp4', 'concat:a.mp4|b.mp4', 'FILE:/etc/passwd', 'pipe:1']) {
    it(`should reject the value ${value}, which names an input`, () => {
      // Act + Assert
      rejectsWith(['-metadata', value], /^Plan value ".*" contains a forbidden reference /u)
    })
  }

  for (const filter of ['movie=/etc/passwd', 'scale=-2:720,subtitles=a.srt', 'drawtext=textfile=a.txt']) {
    it(`should reject the filter chain ${filter}, which uses a filter outside the list`, () => {
      // Act + Assert
      rejectsWith(['-vf', filter], /^Plan uses filter "(?:movie|subtitles|drawtext)", which is not allowed\./u)
    })
  }

  it('should check every filter flag, the audio ones and the generic one included', () => {
    // Act + Assert
    rejectsWith(['-af', 'amovie=a.wav'], /^Plan uses filter "amovie"/u)
    rejectsWith(['-filter', 'null;movie=a.mp4'], /^Plan uses filter "movie"/u)
  })

  it('should not read the value of a non-filter flag as filters', () => {
    // Act + Assert
    validatePlan(plan(['-metadata', 'title=movie=night']))
  })
})

describe('[desktop] Video convert - plan parsing', () => {
  it('should read the plan from a reply that wraps the JSON in prose and a fence', () => {
    // Act
    const parsed = parsePlan(
      'Here it is:\n```json\n{"args": ["-vf", "scale=-2:720"], "outputExtension": "MP4", "summary": " Scale to 720p "}\n```'
    )

    // Assert
    assert.deepEqual(parsed, { args: ['-vf', 'scale=-2:720'], outputExtension: '.mp4', summary: 'Scale to 720p' })
  })

  it('should keep a leading dot on the output extension', () => {
    // Act
    const parsed = parsePlan('{"args": [], "outputExtension": ".gif", "summary": "Make a gif"}')

    // Assert
    assert.equal(parsed.outputExtension, '.gif')
  })

  it('should reject a reply without a JSON object', () => {
    // Act + Assert
    assert.throws(() => parsePlan('I cannot do that.'), {
      name: 'PluginError',
      message: 'Plan model did not return a JSON object. Got: I cannot do that.',
    })
  })

  it('should reject malformed JSON', () => {
    // Act + Assert
    assert.throws(() => parsePlan('{"args": [}'), {
      name: 'PluginError',
      message: /^Plan model returned malformed JSON/u,
    })
  })

  it('should reject args that are not all strings', () => {
    // Act + Assert
    assert.throws(() => parsePlan('{"args": ["-crf", 23], "outputExtension": "mp4", "summary": "x"}'), {
      name: 'PluginError',
      message: 'Plan "args" must be an array of strings.',
    })
  })

  it('should reject a plan without an output extension', () => {
    // Act + Assert
    assert.throws(() => parsePlan('{"args": [], "summary": "x"}'), {
      name: 'PluginError',
      message: 'Plan "outputExtension" must be a string.',
    })
  })

  for (const summary of [undefined, '', '   ']) {
    it(`should reject a plan whose summary is ${JSON.stringify(summary)}`, () => {
      // Act + Assert
      assert.throws(() => parsePlan(JSON.stringify({ args: [], outputExtension: 'mp4', summary })), {
        name: 'PluginError',
        message: 'Plan "summary" must be a non-empty string.',
      })
    })
  }
})

describe('[desktop] Video convert - source metadata', () => {
  const VIDEO = { codec_type: 'video', codec_name: 'h264', width: 320, height: 240 }
  const AUDIO = { codec_type: 'audio', codec_name: 'aac' }

  it('should describe a video with audio', () => {
    // Act
    const metadata = toVideoMetadata('clip.mp4', {
      streams: [VIDEO, AUDIO],
      format: { duration: '1.500000', format_name: 'mov,mp4' },
    })

    // Assert
    assert.deepEqual(metadata, {
      durationSeconds: 1.5,
      video: { width: 320, height: 240, codec: 'h264' },
      hasAudio: true,
      formatName: 'mov,mp4',
    })
  })

  it('should give a still image no duration rather than zero seconds', () => {
    // Act
    const metadata = toVideoMetadata('still.png', {
      streams: [{ ...VIDEO, codec_name: 'png' }],
      format: { format_name: 'png_pipe' },
    })

    // Assert
    assert.equal(metadata.durationSeconds, null)
  })

  it('should give an audio file no video rather than a 0x0 one', () => {
    // Act
    const metadata = toVideoMetadata('tone.wav', { streams: [AUDIO], format: { duration: '1.0', format_name: 'wav' } })

    // Assert
    assert.deepEqual(metadata, { durationSeconds: 1, video: null, hasAudio: true, formatName: 'wav' })
  })

  for (const format_name of [undefined, '', '  ']) {
    it(`should reject a probe whose container format is ${JSON.stringify(format_name)}`, () => {
      // Act + Assert
      assert.throws(() => toVideoMetadata('clip.mp4', { streams: [VIDEO], format: { duration: '1.0', format_name } }), {
        name: 'PluginError',
        message: 'ffprobe reported no container format for "clip.mp4".',
      })
    })
  }

  for (const duration of ['invalid', '12garbage', '-1.000000', '', 'N/A']) {
    it(`should reject the present duration ${JSON.stringify(duration)} rather than read it as a number`, () => {
      // Act + Assert
      assert.throws(() => toVideoMetadata('clip.mp4', { streams: [VIDEO], format: { duration, format_name: 'mov' } }), {
        name: 'PluginError',
        message: `ffprobe reported the duration "${duration}" for "clip.mp4", which is not a number of seconds.`,
      })
    })
  }

  it('should reject a file with neither a video nor an audio stream', () => {
    // Act + Assert
    assert.throws(
      () => toVideoMetadata('subs.mkv', { streams: [{ codec_type: 'subtitle' }], format: { format_name: 'matroska' } }),
      { name: 'PluginError', message: '"subs.mkv" has no video or audio stream to convert.' }
    )
  })

  it('should reject a duration too large to be a finite number of seconds', () => {
    // Arrange
    const duration = '9'.repeat(309)

    // Act + Assert
    assert.throws(() => toVideoMetadata('clip.mp4', { streams: [VIDEO], format: { duration, format_name: 'mov' } }), {
      name: 'PluginError',
      message: `ffprobe reported the duration "${duration}" for "clip.mp4", which is not a number of seconds.`,
    })
  })

  const UNUSABLE_VIDEO_STREAMS = [
    { codec_type: 'video', codec_name: 'h264' },
    { codec_type: 'video', width: 320, height: 240 },
    { ...VIDEO, width: 0, height: 0 },
    { ...VIDEO, width: -320 },
    { ...VIDEO, height: 240.5 },
    { ...VIDEO, codec_name: '' },
  ]
  for (const stream of UNUSABLE_VIDEO_STREAMS) {
    it(`should reject the video stream ${JSON.stringify(stream)}, which has no usable size or codec`, () => {
      // Act + Assert
      assert.throws(() => toVideoMetadata('clip.mp4', { streams: [stream, AUDIO], format: { format_name: 'mov' } }), {
        name: 'PluginError',
        message: 'ffprobe reported no usable size or codec for the video stream of "clip.mp4".',
      })
    })
  }
})
