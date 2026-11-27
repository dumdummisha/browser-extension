import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { MESSAGE_FIELDS, NEW_MESSAGE_SUBTYPES } from '../protocol/slack-message-fields.js'
import { SLACK_READ_METHODS, SLACK_UPLOAD_METHODS, SLACK_WRITE_METHODS } from '../protocol/slack.js'

// The extension's store disclosures: docs/store-disclosures.json says what each permission, host permission and content
// script lets the extension do and why, and docs/store-permissions.md is rendered from it and the manifest, for the
// Chrome Web Store's fields. The docs site renders the same JSON, so every surface explains a permission from one
// source, and a disclosure that names something the manifest lacks, or misses something it has, fails here.

const REPOSITORY_ROOT = new URL('../../', import.meta.url)
const DISCLOSURES_PATH = fileURLToPath(new URL('docs/store-disclosures.json', REPOSITORY_ROOT))
export const MANIFEST_PATH = fileURLToPath(new URL('src/extension/manifest.json', REPOSITORY_ROOT))
export const STORE_PERMISSIONS_PATH = fileURLToPath(new URL('docs/store-permissions.md', REPOSITORY_ROOT))

// The data types the store's privacy practices form asks about, each declared once.
const STORE_DATA_CATEGORIES = [
  'Personally identifiable information',
  'Health information',
  'Financial and payment information',
  'Authentication information',
  'Personal communications',
  'Location',
  'Web history',
  'User activity',
  'Website content',
] as const

// When data flows under a declaration: without any request (automatic), without a request on a Slack tab, or only when
// the Misha app or a browser tool asks.
const CollectionTriggerSchema = z.enum(['automatic', 'slack-tab', 'app-request', 'tool-request'])

const COLLECTION_TRIGGER_LABELS: Readonly<Record<z.infer<typeof CollectionTriggerSchema>, string>> = {
  'automatic': 'automatic',
  'slack-tab': 'on a Slack tab',
  'app-request': 'on a Misha app request',
  'tool-request': 'on a browser tool request',
}

const TextSchema = z.string().min(1)

const DisclosureSchema = z.strictObject({
  capability: TextSchema,
  justification: TextSchema,
  collectionTiming: z.strictObject({ triggers: z.array(CollectionTriggerSchema).min(1), detail: TextSchema }),
  limits: z.array(TextSchema).min(1),
})

const DataCategorySchema = z.strictObject({
  category: z.enum(STORE_DATA_CATEGORIES),
  isHandled: z.boolean(),
  detail: TextSchema,
})

const StoreDisclosuresSchema = z.strictObject({
  privacyPolicyUrl: z.url({ protocol: /^https$/u }),
  permissionsPageUrl: z.url({ protocol: /^https$/u }),
  introduction: z.array(TextSchema).min(1),
  singlePurpose: TextSchema,
  permissions: z.record(z.string(), DisclosureSchema),
  hostPermissions: z.record(z.string(), DisclosureSchema),
  // Keyed by a content script entry's files (contentScriptKey).
  contentScripts: z.record(z.string(), DisclosureSchema),
  notRequested: z.array(TextSchema),
  nativeMessaging: z.array(TextSchema).min(1),
  remoteCode: z.strictObject({ isUsed: z.boolean(), statement: TextSchema }),
  dataUsage: z.strictObject({
    categories: z
      .array(DataCategorySchema)
      .refine(
        (categories) =>
          categories.length === STORE_DATA_CATEGORIES.length &&
          STORE_DATA_CATEGORIES.every((name) => categories.some(({ category }) => category === name)),
        { message: `Declare each store data category exactly once: ${STORE_DATA_CATEGORIES.join(', ')}` }
      ),
    recipients: TextSchema,
    certifications: z.array(TextSchema).min(1),
    limitedUse: TextSchema,
  }),
  credentialHandling: z.strictObject({
    paragraphs: z.array(TextSchema).min(1),
    tabCommandReturns: z.array(TextSchema).min(1),
    outOfScope: TextSchema,
  }),
})

type StoreDisclosures = z.infer<typeof StoreDisclosuresSchema>
type Disclosure = z.infer<typeof DisclosureSchema>

// The manifest's declarations the disclosures account for. A declaration form the disclosures have no text for (optional
// permissions, and a content script's other scope fields such as match_about_blank, exclude_matches or globs) fails the
// parse, so it cannot reach the store text undisclosed; the rest of the manifest grants nothing and is not read here.
const ContentScriptSchema = z.strictObject({
  matches: z.array(TextSchema).min(1),
  js: z.array(TextSchema).min(1),
  run_at: z.enum(['document_start', 'document_end', 'document_idle']).default('document_idle'),
  world: z.enum(['ISOLATED', 'MAIN']).default('ISOLATED'),
  all_frames: z.boolean().default(false),
})

const undisclosed = (field: string): z.ZodOptional<z.ZodNever> =>
  z.never({ error: `The disclosures cover no ${field}; disclose them before declaring them` }).optional()

export const ExtensionManifestSchema = z.object({
  permissions: z.array(TextSchema),
  host_permissions: z.array(TextSchema),
  optional_permissions: undisclosed('optional_permissions'),
  optional_host_permissions: undisclosed('optional_host_permissions'),
  content_scripts: z.array(ContentScriptSchema),
})

type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>
type ContentScript = z.infer<typeof ContentScriptSchema>

export interface IDisclosureInputs {
  readonly disclosures: StoreDisclosures
  readonly manifest: ExtensionManifest
}

const WORLD_TEXT: Readonly<Record<ContentScript['world'], string>> = {
  ISOLATED: "the extension's isolated world",
  MAIN: "the page's own world",
}

const contentScriptKey = ({ js }: Pick<ContentScript, 'js'>): string => js.join(' + ')

const parseJsonFile = <TSchema extends z.ZodType>(schema: TSchema, path: string): z.output<TSchema> => {
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!parsed.success) {
    throw new Error(`${path} does not read:\n${z.prettifyError(parsed.error)}`)
  }

  return parsed.data
}

export const readDisclosureInputs = (): IDisclosureInputs => ({
  disclosures: parseJsonFile(StoreDisclosuresSchema, DISCLOSURES_PATH),
  manifest: parseJsonFile(ExtensionManifestSchema, MANIFEST_PATH),
})

const keyMismatches = (kind: string, declared: readonly string[], disclosed: readonly string[]): string[] => [
  ...declared.filter((key) => !disclosed.includes(key)).map((key) => `The manifest's ${kind} ${key} has no disclosure`),
  ...disclosed
    .filter((key) => !declared.includes(key))
    .map((key) => `The disclosed ${kind} ${key} is not in the manifest`),
]

// Every way the disclosures and the manifest disagree: a declaration with no disclosure, a disclosure of something the
// manifest does not declare, and a permission listed as not requested that the manifest requests.
export const disclosureMismatches = ({ disclosures, manifest }: IDisclosureInputs): string[] => [
  ...keyMismatches('permission', manifest.permissions, Object.keys(disclosures.permissions)),
  ...keyMismatches('host permission', manifest.host_permissions, Object.keys(disclosures.hostPermissions)),
  ...keyMismatches(
    'content script',
    manifest.content_scripts.map(contentScriptKey),
    Object.keys(disclosures.contentScripts)
  ),
  ...disclosures.notRequested
    .filter((permission) => manifest.permissions.includes(permission))
    .map((permission) => `The permission ${permission} is listed as not requested, but the manifest requests it`),
]

const code = (text: string): string => `\`${text}\``

const codeList = (items: readonly string[]): string => items.map(code).join(', ')

const disclosureOf = (disclosures: Readonly<Record<string, Disclosure>>, key: string): Disclosure => {
  const disclosure = disclosures[key]
  if (disclosure === undefined) {
    throw new Error(`No disclosure for ${key}`)
  }

  return disclosure
}

const disclosureSection = (heading: string, disclosure: Disclosure, declaration: string | null): string[] => {
  const { capability, justification, collectionTiming, limits } = disclosure
  const triggers = collectionTiming.triggers.map((trigger) => COLLECTION_TRIGGER_LABELS[trigger]).join(', ')

  return [
    `### ${heading}`,
    ...(declaration === null ? [] : [declaration]),
    `**Capability:** ${capability}`,
    `**Justification:** ${justification}`,
    `**When data flows:** ${triggers.charAt(0).toUpperCase()}${triggers.slice(1)}. ${collectionTiming.detail}`,
    `**Limits:**\n\n${limits.map((limit) => `- ${limit}`).join('\n')}`,
  ]
}

const contentScriptDeclaration = ({ matches, run_at: runAt, world, all_frames: allFrames }: ContentScript): string =>
  `Declared on ${codeList(matches)}, from ${code(runAt)}, in ${WORLD_TEXT[world]}, ${allFrames ? 'in every frame' : 'in the top frame only'}.`

// docs/store-permissions.md, as Markdown blocks joined by blank lines. Permissions, host permissions and content scripts
// follow the manifest's order.
export const renderStorePermissions = (inputs: IDisclosureInputs): string => {
  const mismatches = disclosureMismatches(inputs)
  if (mismatches.length > 0) {
    throw new Error(`The disclosures do not match the manifest:\n${mismatches.join('\n')}`)
  }

  const { disclosures, manifest } = inputs
  const { dataUsage, credentialHandling } = disclosures
  const blocks = [
    '# Chrome Web Store disclosures',
    '> Generated by `pnpm run disclosures` from `docs/store-disclosures.json` and `src/extension/manifest.json`. Edit those, not this file; `pnpm test` fails while this file is stale.',
    ...disclosures.introduction,
    `The docs site explains the same permissions at ${disclosures.permissionsPageUrl}.`,
    '## Single purpose',
    disclosures.singlePurpose,
    '## Permission justifications',
    "Each section is written to be pasted into the store's justification field for that permission or declaration.",
    ...manifest.permissions.flatMap((permission) =>
      disclosureSection(code(permission), disclosureOf(disclosures.permissions, permission), null)
    ),
    ...manifest.host_permissions.flatMap((host) =>
      disclosureSection(`Host permission ${code(host)}`, disclosureOf(disclosures.hostPermissions, host), null)
    ),
    ...manifest.content_scripts.flatMap((script) =>
      disclosureSection(
        `Content script ${codeList(script.js)}`,
        disclosureOf(disclosures.contentScripts, contentScriptKey(script)),
        contentScriptDeclaration(script)
      )
    ),
    `The manifest asks for no other permission. Among those it does not request: ${codeList(disclosures.notRequested)}.`,
    '## Native messaging',
    ...disclosures.nativeMessaging,
    '## Remote code',
    `**Uses remote code:** ${disclosures.remoteCode.isUsed ? 'Yes' : 'No'}.`,
    disclosures.remoteCode.statement,
    '## Data usage',
    dataUsage.categories
      .map(
        ({ category, isHandled, detail }) => `- **${category}:** ${isHandled ? 'Handled' : 'Not handled'}. ${detail}`
      )
      .join('\n'),
    dataUsage.recipients,
    dataUsage.certifications.map((certification) => `- ${certification}`).join('\n'),
    dataUsage.limitedUse,
    '## Privacy policy',
    disclosures.privacyPolicyUrl,
    '## Slack transport limits',
    [
      `- Web API methods the extension calls when the Misha app asks: the reads ${codeList(SLACK_READ_METHODS)}, the writes ${codeList(SLACK_WRITE_METHODS)}, and for an upload ${codeList(SLACK_UPLOAD_METHODS)}.`,
      `- Fields a new message keeps when it leaves the page: ${codeList(MESSAGE_FIELDS)}, and the id of each file it shares.`,
      `- A message is new when it has no subtype or one of ${codeList(NEW_MESSAGE_SUBTYPES)}.`,
    ].join('\n'),
    "## Where Slack's credentials go",
    ...credentialHandling.paragraphs,
    'What the tab commands can return, on the Slack tab or any other:',
    credentialHandling.tabCommandReturns.map((item) => `- ${item}`).join('\n'),
    credentialHandling.outOfScope,
  ]

  return `${blocks.join('\n\n')}\n`
}
