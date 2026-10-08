import { randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asObject } from './format.ts'
import type { UsageReport } from './types.ts'

const REQUEST_TIMEOUT_MS = 15_000
const USAGE_CACHE_DIRECTORY = join(tmpdir(), 'pi-usage-cache')
const USAGE_CACHE_LOCK_WAIT_MS = REQUEST_TIMEOUT_MS + 5_000
const USAGE_CACHE_LOCK_STALE_MS = 60_000
const USAGE_CACHE_MAX_BYTES = 64 * 1024

export const USAGE_CACHE_TTL_MS = 5 * 60 * 1000

export interface UsageCacheOptions {
  directory?: string | undefined
  now?: (() => number) | undefined
}

interface UsageCacheEntry {
  version: 1
  providerId: string
  lastRefreshedAt: number
  report: UsageReport
}

export async function withUsageCache(
  provider: { id: string; name: string },
  refresh: () => Promise<UsageReport>,
  options: UsageCacheOptions = {},
): Promise<UsageReport> {
  const directory = options.directory ?? USAGE_CACHE_DIRECTORY
  const now = options.now ?? Date.now
  const cachePath = join(directory, `${provider.id}.json`)
  const lockPath = join(directory, `${provider.id}.lock`)

  try {
    await prepareUsageCacheDirectory(directory)
  } catch {
    return refresh()
  }

  const cached = await readFreshUsageCache(cachePath, provider.id, now)
  if (cached) {
    return cached
  }

  const deadline = Date.now() + USAGE_CACHE_LOCK_WAIT_MS
  while (true) {
    let lock: Awaited<ReturnType<typeof open>>
    try {
      lock = await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if (getErrorCode(error) !== 'EEXIST') {
        return refresh()
      }

      const updatedCache = await readFreshUsageCache(
        cachePath,
        provider.id,
        now,
      )
      if (updatedCache) {
        return updatedCache
      }
      if (await removeStaleUsageLock(lockPath)) {
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${provider.name} usage is already being refreshed. Try again shortly.`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      continue
    }

    try {
      const updatedCache = await readFreshUsageCache(
        cachePath,
        provider.id,
        now,
      )
      if (updatedCache) {
        return updatedCache
      }

      const report = await refresh()
      try {
        await writeUsageCache(cachePath, provider.id, report, now())
      } catch {
        // A cache write failure must not hide a successful provider response.
      }
      return report
    } finally {
      await lock.close().catch(() => {})
      await unlink(lockPath).catch(() => {})
    }
  }
}

async function prepareUsageCacheDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Usage cache path is not a directory.')
  }
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw new Error('Usage cache directory belongs to another user.')
    }
    await chmod(directory, 0o700)
  }
}

async function readFreshUsageCache(
  cachePath: string,
  providerId: string,
  now: () => number,
): Promise<UsageReport | undefined> {
  try {
    const info = await lstat(cachePath)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > USAGE_CACHE_MAX_BYTES
    ) {
      return undefined
    }
    const value: unknown = JSON.parse(await readFile(cachePath, 'utf8'))
    const entry = asObject(value)
    if (
      entry?.version !== 1 ||
      entry.providerId !== providerId ||
      typeof entry.lastRefreshedAt !== 'number' ||
      !Number.isFinite(entry.lastRefreshedAt) ||
      !isUsageReport(entry.report)
    ) {
      return undefined
    }
    const age = now() - entry.lastRefreshedAt
    return age >= 0 && age < USAGE_CACHE_TTL_MS ? entry.report : undefined
  } catch {
    return undefined
  }
}

function isUsageReport(value: unknown): value is UsageReport {
  const report = asObject(value)
  return (
    report !== undefined &&
    typeof report.provider === 'string' &&
    report.provider.length <= 200 &&
    Array.isArray(report.lines) &&
    report.lines.length <= 32 &&
    report.lines.every(
      (line) => typeof line === 'string' && line.length <= 1000,
    ) &&
    typeof report.status === 'string' &&
    report.status.length <= 1000
  )
}

async function writeUsageCache(
  cachePath: string,
  providerId: string,
  report: UsageReport,
  lastRefreshedAt: number,
): Promise<void> {
  const entry: UsageCacheEntry = {
    version: 1,
    providerId,
    lastRefreshedAt,
    report,
  }
  const tempPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, JSON.stringify(entry), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    await rename(tempPath, cachePath)
  } finally {
    await unlink(tempPath).catch(() => {})
  }
}

async function removeStaleUsageLock(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath)
    if (Date.now() - info.mtimeMs < USAGE_CACHE_LOCK_STALE_MS) {
      return false
    }
    await unlink(lockPath)
    return true
  } catch (error) {
    return getErrorCode(error) === 'ENOENT'
  }
}

function getErrorCode(error: unknown): string | undefined {
  const record = asObject(error)
  return typeof record?.code === 'string' ? record.code : undefined
}
