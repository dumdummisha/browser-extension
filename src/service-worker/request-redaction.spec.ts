import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { redactBody, redactHeaders, redactUrl } from './request-redaction.js'

const OPAQUE_SECRET = ['opaque', 'value', '0123456789'].join('-')
const SESSION_COOKIE = ['session', 'c2Vzc2lvbi1leGFtcGxl'].join('=')
const MULTIPART_BOUNDARY = '----FormBoundaryExample123'

// Token-shaped samples are assembled at run time, so the repository holds nothing a secret scanner would flag.
const SLACK_SESSION_TOKEN = ['xoxc', '2048', '4096', 'aBcDeFgHiJkLmNoP'].join('-')
const SHAPED_SAMPLES = {
  'Slack session token': SLACK_SESSION_TOKEN,
  'Slack app-level token': ['xapp', '1', 'A0123456789', 'abcdef0123456789'].join('-'),
  'GitHub token': ['ghp', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5'].join('_'),
  'AWS access key id': ['AKIA', 'Z7Q2M4N6P8R0T2V4'].join(''),
  'JSON Web Token': ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJleGFtcGxlIn0', 'c2lnbmF0dXJlLXZhbHVl'].join('.'),
  'Bearer value': ['Bearer', OPAQUE_SECRET].join(' '),
  'private key': [
    ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
    'MIIEowIBAAKCAQEA',
    ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
  ].join('\n'),
}

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
