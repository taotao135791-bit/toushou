/**
 * Pure half of the plugin scaffold: validation and file-content generation,
 * with no filesystem access (that lives in src/main/pluginScaffold.ts).
 * Kept in shared/ so the renderer can reuse the validators for form UX.
 *
 * Generated packages follow the pi package spec:
 * https://badlogic-pi-mono.mintlify.app/coding-agent/pi-packages
 */
import {
  PluginScaffoldError,
  PluginScaffoldSpec,
  PluginTemplate
} from './types'

/** npm name rules (unscoped or @scope/name), lowercase kebab. */
export const PACKAGE_NAME_PATTERN = /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9-]*$/

/** Loose semver: x.y.z with optional pre-release/build suffix. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

const MAX_NAME_LENGTH = 214

export function isValidPackageName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME_LENGTH && PACKAGE_NAME_PATTERN.test(name)
}

export function isValidVersion(version: string): boolean {
  return VERSION_PATTERN.test(version)
}

/** Package name without the npm scope, used for skill/prompt file names. */
export function unscopedName(name: string): string {
  const slash = name.indexOf('/')
  return slash === -1 ? name : name.slice(slash + 1)
}

const TEMPLATES: readonly PluginTemplate[] = ['blank', 'command', 'tool-guard']

export function validatePluginSpec(spec: PluginScaffoldSpec): PluginScaffoldError | null {
  if (!isValidPackageName(spec.name)) return 'invalid-name'
  if (!isValidVersion(spec.version)) return 'invalid-version'
  if (typeof spec.description !== 'string' || !spec.description.trim()) return 'invalid-spec'
  if (!spec.extension && !spec.skill && !spec.prompt) return 'no-resources'
  if (spec.extension && !TEMPLATES.includes(spec.template)) return 'invalid-spec'
  if (typeof spec.parentDir !== 'string' || !spec.parentDir.trim()) return 'dir-missing'
  return null
}

export interface PlannedFile {
  /** Path relative to the package root, posix separators. */
  relativePath: string
  content: string
}

const PI_DOCS_URL = 'https://badlogic-pi-mono.mintlify.app/coding-agent'

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

function renderPackageJson(spec: PluginScaffoldSpec): string {
  const pi: Record<string, string[]> = {}
  const files: string[] = []
  if (spec.extension) {
    pi.extensions = ['extensions/index.ts']
    files.push('extensions')
  }
  if (spec.skill) {
    pi.skills = ['skills']
    files.push('skills')
  }
  if (spec.prompt) {
    pi.prompts = ['prompts']
    files.push('prompts')
  }

  const manifest: Record<string, unknown> = {
    name: spec.name,
    version: spec.version,
    description: spec.description.trim()
  }
  if (spec.displayName?.trim()) manifest.displayName = spec.displayName.trim()
  if (spec.author?.trim()) manifest.author = spec.author.trim()
  manifest.license = 'MIT'
  manifest.keywords = ['pi-package']
  if (spec.extension) {
    // pi bundles its core packages; peer-declare them, never bundle them.
    manifest.peerDependencies = { '@mariozechner/pi-coding-agent': '*' }
  }
  manifest.pi = pi
  manifest.files = files
  return JSON.stringify(manifest, null, 2) + '\n'
}

// ---------------------------------------------------------------------------
// extensions/index.ts
// ---------------------------------------------------------------------------

function extensionHeader(spec: PluginScaffoldSpec): string {
  return `/**
 * ${spec.name} — a pi extension.
 *
 * pi loads extensions as plain TypeScript via jiti (no build step): this file
 * default-exports a function that receives pi's ExtensionAPI. The types come
 * from pi's core packages (peer-declared in package.json and resolved from
 * pi's own bundled copies at runtime).
 *
 * Docs: ${PI_DOCS_URL}/extensions
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
`
}

function renderExtension(spec: PluginScaffoldSpec): string {
  const header = extensionHeader(spec)
  if (spec.template === 'command') {
    const command = unscopedName(spec.name)
    return `${header}
export default function (pi: ExtensionAPI) {
  // Registers the slash command /${command} — type it in any pi session.
  // registerCommand can also provide argument completions and more; see
  // ${PI_DOCS_URL}/extensions#custom-commands
  pi.registerCommand('${command}', {
    description: ${JSON.stringify(spec.description.trim())},
    handler: async (args, ctx) => {
      ctx.ui.notify('Hello ' + (args.trim() || 'world') + '!', 'info')
    }
  })
}
`
  }
  if (spec.template === 'tool-guard') {
    return `${header}
// Extend this list with whatever you consider dangerous.
const BLOCKED = [/\\brm\\s+-rf\\b/, /\\bgit\\s+push\\b.*--force/]

export default function (pi: ExtensionAPI) {
  // tool_call fires before a tool executes; returning { block, reason } vetoes it.
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return
    const command = typeof event.input?.command === 'string' ? event.input.command : ''
    if (!BLOCKED.some((pattern) => pattern.test(command))) return
    const ok = await ctx.ui.confirm('Dangerous command', 'Allow: ' + command + ' ?')
    if (!ok) return { block: true, reason: 'Blocked by ${spec.name}' }
  })
}
`
  }
  return `${header}
export default function (pi: ExtensionAPI) {
  // Subscribe to events, register slash commands or tools here, e.g.:
  //
  // pi.on('session_start', async (_event, ctx) => {
  //   ctx.ui.notify('Hello from ${spec.name}', 'info')
  // })
  //
  // See ${PI_DOCS_URL}/extensions for the full ExtensionAPI surface.
  void pi
}
`
}

// ---------------------------------------------------------------------------
// skills/<name>/SKILL.md and prompts/<name>.md
// ---------------------------------------------------------------------------

function renderSkill(spec: PluginScaffoldSpec): string {
  const skill = unscopedName(spec.name)
  const title = spec.displayName?.trim() || skill
  return `---
name: ${skill}
description: ${spec.description.trim()}
---

# ${title}

Describe the workflow this skill teaches the agent.

## When to use

- TODO: the situations where the agent should reach for this skill.

## Instructions

1. TODO: step-by-step guidance for the agent.
`
}

function renderPrompt(spec: PluginScaffoldSpec): string {
  const prompt = unscopedName(spec.name)
  const title = spec.displayName?.trim() || prompt
  return `# ${title}

${spec.description.trim()}

---

Write the prompt template body here. Installed prompt templates become
available as slash commands in pi; see ${PI_DOCS_URL}/pi-packages.
`
}

// ---------------------------------------------------------------------------
// README.md
// ---------------------------------------------------------------------------

function renderReadme(spec: PluginScaffoldSpec): string {
  const title = spec.displayName?.trim() || spec.name
  const contents: string[] = []
  if (spec.extension) contents.push('- `extensions/index.ts` — pi extension (plain TypeScript, loaded via jiti)')
  if (spec.skill) contents.push(`- \`skills/${unscopedName(spec.name)}/SKILL.md\` — agent skill`)
  if (spec.prompt) contents.push(`- \`prompts/${unscopedName(spec.name)}.md\` — prompt template`)
  return `# ${title}

${spec.description.trim()}

## Install

From a local checkout:

\`\`\`sh
pi install /absolute/path/to/${spec.name}
\`\`\`

Or publish it and install from npm or git:

\`\`\`sh
npm publish                                   # then: pi install npm:${spec.name}
git tag v${spec.version} && git push --tags   # then: pi install git:github.com/<you>/${unscopedName(spec.name)}@v${spec.version}
\`\`\`

## Contents

${contents.join('\n')}

## Development

Package spec: ${PI_DOCS_URL}/pi-packages
Extension API: ${PI_DOCS_URL}/extensions
`
}

// ---------------------------------------------------------------------------
// File plan
// ---------------------------------------------------------------------------

/**
 * The full file set for a spec, in deterministic order. All paths are derived
 * from the validated package name — never from free-form user input.
 */
export function planPluginFiles(spec: PluginScaffoldSpec): PlannedFile[] {
  const base = unscopedName(spec.name)
  const files: PlannedFile[] = [
    { relativePath: 'package.json', content: renderPackageJson(spec) },
    { relativePath: 'README.md', content: renderReadme(spec) }
  ]
  if (spec.extension) {
    files.push({ relativePath: 'extensions/index.ts', content: renderExtension(spec) })
  }
  if (spec.skill) {
    files.push({ relativePath: `skills/${base}/SKILL.md`, content: renderSkill(spec) })
  }
  if (spec.prompt) {
    files.push({ relativePath: `prompts/${base}.md`, content: renderPrompt(spec) })
  }
  return files
}
