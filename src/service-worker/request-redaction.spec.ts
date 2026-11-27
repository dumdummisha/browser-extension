import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { redactBody, redactHeaders, redactLines, redactText, redactUrl } from './request-redaction.js'

const OPAQUE_SECRET = ['opaque', 'value', '0123456789'].join('-')
const SESSION_COOKIE = ['session', 'c2Vzc2lvbi1leGFtcGxl'].join('=')
const MULTIPART_BOUNDARY = '----FormBoundaryExample123'

const pemLine = (edge: 'BEGIN' | 'END', label: string): string =>
  [`-----${edge}`, ...(label === '' ? [] : [label]), 'PRIVATE', 'KEY-----'].join(' ')

// Token-shaped samples are assembled at run time, so the repository holds nothing a secret scanner would flag.
const SLACK_SESSION_TOKEN = ['xoxc', '2048', '4096', 'aBcDeFgHiJkLmNoP'].join('-')

const SHAPED_SAMPLES = {
  'Slack session token': SLACK_SESSION_TOKEN,
  'Slack app-level token': ['xapp', '1', 'A0123456789', 'abcdef0123456789'].join('-'),
  'GitHub token': ['ghp', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5'].join('_'),
  'AWS access key id': ['AKIA', 'Z7Q2M4N6P8R0T2V4'].join(''),
  'JSON Web Token': ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJleGFtcGxlIn0', 'c2lnbmF0dXJlLXZhbHVl'].join('.'),
  'Bearer value': ['Bearer', OPAQUE_SECRET].join(' '),
  'private key': [pemLine('BEGIN', 'RSA'), 'MIIEowIBAAKCAQEA', pemLine('END', 'RSA')].join('\n'),
}

const SLACK_BOT_TOKEN = ['xoxb', '1024', '2048', 'zYxWvUtSrQpOnMlK'].join('-')
const ANTHROPIC_KEY = ['sk', 'ant', 'api03', 'aBcDeFgHiJkLmNoPqRsTuV'].join('-')
const OPENAI_KEY = ['sk', 'proj', 'aBcDeFgHiJkLmNoPqRsTuVwX'].join('-')
const KEY_LINES = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7exampleBody'] as const
const KEY_BODY = [...KEY_LINES, 'c2FtcGxlLWtleS1ib2R5LWxpbmU=']

const multipart = (parts: readonly (readonly [string, string])[]): string =>
  [
    ...parts.flatMap(([name, value]) => [
      `--${MULTIPART_BOUNDARY}`,
      `Content-Disposition: form-data; name="${name}"`,
      '',
      value,
    ]),
    `--${MULTIPART_BOUNDARY}--`,
    '',
  ].join('\r\n')

describe('[service-worker] Request redaction - bodies', () => {
  it('should redact a credential-named form field and keep the other fields as sent', () => {
    // Act
    const redacted = redactBody(
      `token=${SLACK_SESSION_TOKEN}&channel=C0123&text=Hello+there&user%5Bpassword%5D=${OPAQUE_SECRET}`
    )

    // Assert
    assert.equal(redacted, 'token=[redacted]&channel=C0123&text=Hello+there&user%5Bpassword%5D=[redacted]')
  })

  it('should redact every credential name in a JSON body, case-insensitively and nested', () => {
    // Arrange
    const body = JSON.stringify({
      Token: OPAQUE_SECRET,
      user: { name: 'Ada', PASSWORD: OPAQUE_SECRET },
      secret: OPAQUE_SECRET,
      api_key: OPAQUE_SECRET,
      ApiKey: OPAQUE_SECRET,
      access_token: OPAQUE_SECRET,
      refresh_token: OPAQUE_SECRET,
      client_secret: OPAQUE_SECRET,
      Authorization: { scheme: 'custom', value: OPAQUE_SECRET },
      page: 2,
    })

    // Act
    const redacted = redactBody(body)

    // Assert
    assert.equal(
      redacted,
      '{"Token":"[redacted]","user":{"name":"Ada","PASSWORD":"[redacted]"},"secret":"[redacted]",' +
        '"api_key":"[redacted]","ApiKey":"[redacted]","access_token":"[redacted]","refresh_token":"[redacted]",' +
        '"client_secret":"[redacted]","Authorization":"[redacted]","page":2}'
    )
  })

  it('should redact a truncated JSON body as far as it goes', () => {
    // Act
    const redacted = redactBody(`{"query":"me","variables":{"password":"${OPAQUE_SECRET.slice(0, 9)}`)

    // Assert
    assert.equal(redacted, '{"query":"me","variables":{"password":"[redacted]"')
  })

  it('should redact a credential-named multipart field and a token-shaped one', () => {
    // Act
    const redacted = redactBody(
      multipart([
        ['token', SLACK_SESSION_TOKEN],
        ['channel', 'C0123'],
        ['note', `key ${SHAPED_SAMPLES['AWS access key id']}`],
      ])
    )

    // Assert
    assert.equal(
      redacted,
      multipart([
        ['token', '[redacted]'],
        ['channel', 'C0123'],
        ['note', '[redacted]'],
      ])
    )
  })

  it('should keep the redacted structure of a JSON payload nested in a form, JSON or multipart field', () => {
    // Arrange
    const payload = JSON.stringify({ token: OPAQUE_SECRET, channel: 'C0123', blocks: [{ type: 'section' }] })
    const redactedPayload = JSON.stringify({ token: '[redacted]', channel: 'C0123', blocks: [{ type: 'section' }] })

    // Act
    const form = redactBody(`payload=${encodeURIComponent(payload)}&count=1`)
    const json = redactBody(JSON.stringify({ payload, count: 1 }))
    const multipartBody = redactBody(multipart([['payload', payload]]))

    // Assert
    assert.equal(form, `payload=${encodeURIComponent(redactedPayload)}&count=1`)
    assert.equal(json, JSON.stringify({ payload: redactedPayload, count: 1 }))
    assert.equal(multipartBody, multipart([['payload', redactedPayload]]))
  })

  it('should redact a URL-valued body field as a URL', () => {
    // Act
    const redacted = redactBody(
      JSON.stringify({ redirect: `https://app.example.test/cb?code=1&token=${OPAQUE_SECRET}` })
    )

    // Assert
    assert.equal(redacted, JSON.stringify({ redirect: 'https://app.example.test/cb?code=1&token=[redacted]' }))
  })

  for (const [kind, sample] of Object.entries(SHAPED_SAMPLES)) {
    it(`should redact a ${kind} by its shape in JSON, form and plain bodies`, () => {
      // Act
      const json = redactBody(JSON.stringify({ text: `use ${sample} here`, count: 1 }))
      const form = redactBody(`text=${encodeURIComponent(sample)}&count=1`)
      const plain = redactBody(sample)

      // Assert
      assert.deepEqual(
        [json, form, plain],
        ['{"text":"[redacted]","count":1}', 'text=[redacted]&count=1', '[redacted]']
      )
    })
  }
})

describe('[service-worker] Request redaction - URLs and headers', () => {
  it('should redact credentials in the query string and keep the other parameters', () => {
    // Act
    const redacted = redactUrl(`https://app.example.com/api/items?access_token=${OPAQUE_SECRET}&page=2`)

    // Assert
    assert.equal(redacted, 'https://app.example.com/api/items?access_token=[redacted]&page=2')
  })

  it('should redact a percent-encoded token in the path and keep the other segments as written', () => {
    // Arrange
    const encodedToken = `%78${SLACK_SESSION_TOKEN.slice(1)}`

    // Act
    const redacted = redactUrl(`https://app.example.com/session/${encodedToken}/caf%C3%A9/%zz%FF%E0%A4`)

    // Assert
    assert.equal(redacted, 'https://app.example.com/session/[redacted]/caf%C3%A9/%zz%FF%E0%A4')
  })

  it('should redact the userinfo of a URL whatever it holds or encodes, a URL-valued field included', () => {
    // Arrange
    const userinfos = [
      `example-user:${OPAQUE_SECRET}`,
      `example%20user:${encodeURIComponent(`${OPAQUE_SECRET}@:/`)}`,
      `user@example.test:${OPAQUE_SECRET}`,
      'example-user',
    ]

    const redirect = encodeURIComponent(`https://example-user:${OPAQUE_SECRET}@files.example.test/a`)

    // Act
    const redacted = userinfos.map((userinfo) => redactUrl(`https://${userinfo}@app.example.test/report/@team?page=2`))
    const nested = redactUrl(`https://app.example.test/login?next=${redirect}`)

    // Assert
    assert.deepEqual(redacted, Array(userinfos.length).fill('https://[redacted]@app.example.test/report/@team?page=2'))

    assert.equal(
      nested,
      `https://app.example.test/login?next=${encodeURIComponent('https://[redacted]@files.example.test/a')}`
    )
  })

  it('should redact the opaque path of a Slack upload URL, which itself authorizes the upload', () => {
    // Arrange
    const grant = ['F0EXAMPLE', 'opaque', 'example', 'grant'].join('-')

    // Act
    const redacted = [
      `https://files.slack.com/upload/v1/${grant}`,
      `https://Files.Slack.com:443/upload/v1/${grant}/part?filename=report.txt`,
      `https://files.slack.com/files-pri/T0EXAMPLE-F0EXAMPLE/report.txt`,
    ].map(redactUrl)

    // Assert
    assert.deepEqual(redacted, [
      'https://files.slack.com/upload/[redacted]',
      'https://Files.Slack.com:443/upload/[redacted]?filename=report.txt',
      'https://files.slack.com/files-pri/T0EXAMPLE-F0EXAMPLE/report.txt',
    ])
  })

  it('should keep a URL without credentials as it is', () => {
    // Act
    const redacted = redactUrl('https://app.example.com/reports/2026?page=2#summary')

    // Assert
    assert.equal(redacted, 'https://app.example.com/reports/2026?page=2#summary')
  })

  it('should redact every credential header, a URL-valued one as a URL and a structured one field by field', () => {
    // Act
    const redacted = redactHeaders([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Cookie', value: SESSION_COOKIE },
      { name: 'Authorization', value: `Basic ${OPAQUE_SECRET}` },
      { name: 'X-Api-Key', value: OPAQUE_SECRET },
      { name: 'X-Trace', value: SHAPED_SAMPLES['JSON Web Token'] },
      { name: 'Referer', value: `https://app.example.test/reset?token=${OPAQUE_SECRET}&step=2` },
      { name: 'X-Context', value: JSON.stringify({ secret: OPAQUE_SECRET, team: 'T0123' }) },
    ])

    // Assert
    assert.deepEqual(redacted, [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Cookie', value: '[redacted]' },
      { name: 'Authorization', value: '[redacted]' },
      { name: 'X-Api-Key', value: '[redacted]' },
      { name: 'X-Trace', value: '[redacted]' },
      { name: 'Referer', value: 'https://app.example.test/reset?token=[redacted]&step=2' },
      { name: 'X-Context', value: '{"secret":"[redacted]","team":"T0123"}' },
    ])
  })
})

describe('[service-worker] Request redaction - page text', () => {
  for (const [kind, sample] of Object.entries(SHAPED_SAMPLES)) {
    it(`should redact a ${kind} inside page text and keep the text around it`, () => {
      // Arrange
      const lineBreaks = '\n'.repeat(sample.split('\n').length - 1)

      // Act
      const redacted = redactText(`Copy ${sample} into the app.`)

      // Assert
      assert.equal(redacted, `Copy [redacted]${lineBreaks} into the app.`)
    })
  }

  it('should redact every occurrence of a token and each of several tokens', () => {
    // Act
    const redacted = redactText(
      `User ${SLACK_SESSION_TOKEN}, bot ${SLACK_BOT_TOKEN}; user again ${SLACK_SESSION_TOKEN}.`
    )

    // Assert
    assert.equal(redacted, 'User [redacted], bot [redacted]; user again [redacted].')
  })

  it('should redact matches of overlapping shapes as one span', () => {
    // Act
    const redacted = [
      `Authorization: Bearer ${SHAPED_SAMPLES['JSON Web Token']} sent`,
      `Anthropic ${ANTHROPIC_KEY} and OpenAI ${OPENAI_KEY}`,
    ].map(redactText)

    // Assert
    assert.deepEqual(redacted, ['Authorization: [redacted] sent', 'Anthropic [redacted] and OpenAI [redacted]'])
  })

  it('should redact a multiline private key line by line and keep the lines around it', () => {
    // Arrange
    const lines = [
      '## [3] Deploy key',
      pemLine('BEGIN', 'RSA'),
      ...KEY_BODY,
      pemLine('END', 'RSA'),
      '[12] button "Copy"',
    ]

    // Act
    const redacted = redactLines(lines)

    // Assert
    assert.deepEqual(redacted, ['## [3] Deploy key', '[redacted]', '', '', '', '', '[12] button "Copy"'])
  })

  it('should redact a private key an outline collapsed into one field value', () => {
    // Arrange
    const key = [pemLine('BEGIN', ''), ...KEY_BODY, pemLine('END', '')].join(' ')

    // Act
    const redacted = redactText(`[4] textbox "Key" value="${key}" readonly`)

    // Assert
    assert.equal(redacted, '[4] textbox "Key" value="[redacted]" readonly')
  })

  it('should redact an encrypted private key through its headers, whole or cut off before its END', () => {
    // Arrange
    const headers = ['Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,0123456789ABCDEF', '']
    const whole = [pemLine('BEGIN', 'RSA'), ...headers, ...KEY_BODY, pemLine('END', 'RSA'), 'Keep it safe.']
    const cutOff = [pemLine('BEGIN', 'RSA'), ...headers, ...KEY_BODY, '[7] button "Download"']

    // Act
    const redacted = [whole, cutOff].map(redactLines)

    // Assert
    assert.deepEqual(redacted, [
      ['[redacted]', '', '', '', '', '', '', '', 'Keep it safe.'],
      ['[redacted]', '', '', '', '', '', '', '[7] button "Download"'],
    ])
  })

  it('should end a private key cut off before its END at the next BEGIN line', () => {
    // Arrange
    const lines = [
      pemLine('BEGIN', 'EC'),
      KEY_LINES[0],
      pemLine('BEGIN', 'RSA'),
      KEY_LINES[1],
      pemLine('END', 'RSA'),
      'Rotated today.',
    ]

    // Act
    const redacted = redactLines(lines)

    // Assert
    assert.deepEqual(redacted, ['[redacted]', '', '[redacted]', '', '', 'Rotated today.'])
  })

  it('should end a private key cut off before its END at the first character no key body holds', () => {
    // Arrange
    const clipped = `[4] textbox "Key" value="${pemLine('BEGIN', '')} ${KEY_LINES[0]}…" readonly`
    // Text alone cannot tell words of base64 letters from a body line, so they go with the key they follow.
    const followed = `${pemLine('BEGIN', '')} ${KEY_LINES[0]} keep it safe. Next step`

    // Act
    const redacted = [clipped, followed].map(redactText)

    // Assert
    assert.deepEqual(redacted, ['[4] textbox "Key" value="[redacted]…" readonly', '[redacted]. Next step'])
  })

  it('should never make a text longer, however short the lines a span runs across', () => {
    // Arrange
    const shortLines = [pemLine('BEGIN', ''), ...Array.from({ length: 30 }, () => 'QUJD'), pemLine('END', '')].join(
      '\n'
    )

    const spreadBearer = `Bearer\n\n\n\n${OPAQUE_SECRET}`

    // Act
    const redacted = [redactText(shortLines), redactText(spreadBearer)] as const

    // Assert
    assert.deepEqual(redacted, [`[redacted]${'\n'.repeat(31)}`, '[redacted]\n\n\n\n'])
    assert.ok(redacted[0].length < shortLines.length && redacted[1].length < spreadBearer.length)
  })

  it('should answer as many lines as it is given, none included', () => {
    // Act
    const redacted = [[], [''], ['', ''], [`token ${SLACK_BOT_TOKEN}`, '']].map(redactLines)

    // Assert
    assert.deepEqual(redacted, [[], [''], ['', ''], ['token [redacted]', '']])
  })

  it('should keep text without a known credential shape as it is', () => {
    // Arrange
    const text = '# [1] Settings\n[2] textbox "Name" value="Example Team"\nBearer of good news | sk-short'

    // Act
    const redacted = redactText(text)

    // Assert
    assert.equal(redacted, text)
  })
})
