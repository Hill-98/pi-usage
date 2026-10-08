import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const cliArgs = process.argv.slice(2)
const positionalArgs = cliArgs[0] === '--' ? cliArgs.slice(1) : cliArgs
const provider = positionalArgs[0] ?? 'openai-codex'
const modelId = positionalArgs[1] ?? defaultModel(provider)
const extension = resolve('dist/index.js')
const child = spawn(
  'pi',
  [
    '--mode',
    'rpc',
    '--no-session',
    '--no-extensions',
    '--extension',
    extension,
    '--model',
    `${provider}/${modelId}`,
  ],
  { stdio: ['pipe', 'pipe', 'pipe'] },
)

let output = ''
let stderr = ''
let requestSent = false
let finished = false
const timeout = setTimeout(
  () => finish(false, 'Pi usage request timed out.'),
  60_000,
)

child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-4000)
})
child.stdout.on('data', (chunk) => {
  output += chunk
  while (true) {
    const newline = output.indexOf('\n')
    if (newline < 0) {
      break
    }
    const line = output.slice(0, newline)
    output = output.slice(newline + 1)
    let record: RpcRecord
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }

    if (
      !requestSent &&
      record.type === 'response' &&
      record.command === 'get_commands' &&
      record.success
    ) {
      const hasUsage = record.data?.commands?.some(
        (command) => command.name === 'usage',
      )
      if (!hasUsage) {
        finish(false, 'The local Pi process did not register /usage.')
        return
      }
      requestSent = true
      child.stdin.write(
        `${JSON.stringify({
          id: 'usage-smoke',
          type: 'prompt',
          message: '/usage',
        })}\n`,
      )
      return
    }

    if (record.type === 'extension_ui_request' && record.method === 'notify') {
      const message = String(record.message ?? '')
      if (record.notifyType === 'warning' || record.notifyType === 'error') {
        finish(
          false,
          `Pi loaded /usage, but the provider query was unsuccessful: ${message.slice(0, 480)}`,
        )
        return
      }
      const labels = [...message.matchAll(/^• ([^:]+):/gm)].map(
        (match) => match[1],
      )
      if (!message.toLowerCase().includes('usage') || labels.length === 0) {
        finish(false, 'Pi returned an unexpected usage report.')
        return
      }
      finish(true, `${provider}: report received (${labels.join(', ')}).`)
      return
    }
  }
})

child.on('error', () =>
  finish(false, 'Could not start the local pi executable.'),
)
child.on('exit', (code) => {
  if (!finished) {
    finish(
      false,
      summarizeStderr(stderr) ??
        (code === 0
          ? 'Pi exited before returning usage.'
          : 'Pi exited with an error.'),
    )
  }
})

child.stdin.write(
  `${JSON.stringify({ id: 'commands', type: 'get_commands' })}\n`,
)

function finish(success: boolean, message: string): void {
  if (finished) {
    return
  }
  finished = true
  clearTimeout(timeout)
  child.stdin.end()
  if (success) {
    console.log(`Local Pi smoke test passed: ${message}`)
  } else {
    console.error(`Local Pi smoke test failed: ${message}`)
    child.kill()
    process.exitCode = 1
  }
}

function defaultModel(providerId: string): string {
  if (providerId === 'openai-codex') {
    return 'gpt-5.5'
  }
  if (providerId === 'kimi-coding') {
    return 'kimi-for-coding'
  }
  return ''
}

function summarizeStderr(value: string): string | undefined {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const line =
    lines.find((candidate) =>
      /error|fatal|failed|cannot|not found|permission|denied/i.test(candidate),
    ) ?? lines[0]
  if (!line) {
    return undefined
  }
  const safeLine = line
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(
      /"(?:access|refresh)_token"\s*:\s*"[^"]+"/gi,
      '"token":"<redacted>"',
    )
    .slice(0, 480)
  return `Pi startup failed: ${safeLine}`
}

interface RpcRecord {
  type?: string
  command?: string
  success?: boolean
  method?: string
  notifyType?: string
  message?: string
  data?: {
    commands?: Array<{ name: string }>
  }
}
