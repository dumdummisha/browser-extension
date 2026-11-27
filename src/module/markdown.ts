// Tool results as markdown the model reads: one line per call, joined at build.
export class MarkdownBuilder {
  private readonly lines: string[] = []

  public static readonly create = (): MarkdownBuilder => new MarkdownBuilder()

  public readonly heading = (text: string, level: 2 | 3): this => this.push(`${'#'.repeat(level)} ${text}`, '')

  public readonly field = (label: string, value: string): this => this.push(`**${label}:** ${value}`)

  public readonly text = (content: string): this => this.push(content)

  public readonly blank = (): this => this.push('')

  public readonly bullet = (text: string): this => this.push(`- ${text}`)

  // The fence outruns every backtick run in the content, so no content line can close the block early.
  public readonly codeBlock = (content: string): this => {
    const longestRun = (content.match(/`+/gu) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0)
    const fence = '`'.repeat(Math.max(3, longestRun + 1))

    return this.push(fence, content, fence)
  }

  public readonly italic = (text: string): this => this.push(`_${text}_`)

  public readonly table = (headers: string[], rows: string[][]): this => {
    this.push(`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`)

    for (const row of rows) {
      this.push(`| ${row.join(' | ')} |`)
    }

    return this.push('')
  }

  public readonly build = (): string => this.lines.join('\n')

  private readonly push = (...lines: string[]): this => {
    this.lines.push(...lines)

    return this
  }
}
