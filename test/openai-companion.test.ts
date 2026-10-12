import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeOpenAICompanion,
  parseOpenAIAppUsage,
} from '../src/usage/providers/openai-companion.ts'
import type { UnknownRecord } from '../src/usage/types.ts'

const weeklyWindow = {
  used_percent: 12,
  limit_window_seconds: 604_800,
  reset_at: 1_800_000_000,
}
const fiveHourWindow = {
  used_percent: 35,
  limit_window_seconds: 18_000,
  reset_at: 1_800_100_000,
}

test('native OpenAI Plus keeps plan and app limits separate and displays both plan windows', () => {
  const report = normalizeOpenAICompanion(
    {
      plan_type: 'plus',
      rate_limit: {
        primary_window: fiveHourWindow,
        secondary_window: weeklyWindow,
      },
      additional_rate_limits: [
        {
          rate_limit: {
            primary_window: { ...fiveHourWindow, used_percent: 99 },
          },
        },
      ],
    },
    appUsage(),
  )
  assert.deepEqual(
    report.lines.slice(0, 4).map((line) => line.split(':')[0]),
    ['Plan 5h', 'Plan week', 'App 5h', 'App week'],
  )
  assert.equal(report.status, 'plan 5h 65% · week 88%')
  assert.match(report.lines[4] ?? '', /App allowance: 50%.*cap, not remaining/)
  assert.doesNotMatch(report.status, /app|50%|99%/i)
  assert.ok(report.lines.slice(2, 4).every((line) => !line.includes('%')))
})

test('native OpenAI Pro displays only weekly windows even if a 5h window is returned', () => {
  const report = normalizeOpenAICompanion(
    {
      plan_type: 'chatgpt-pro',
      rate_limit: {
        primary_window: fiveHourWindow,
        secondary_window: weeklyWindow,
      },
    },
    appUsage(),
  )
  assert.equal(report.status, 'plan week 88%')
  assert.deepEqual(
    report.lines
      .filter((line) => /^(Plan|App) (5h|week):/.test(line))
      .map((line) => line.split(':')[0]),
    ['Plan week', 'App week'],
  )
  assert.doesNotMatch(report.lines.join('\n'), /^(Plan|App) 5h:/m)
})

test('native OpenAI Pro recognizes a weekly window in the primary slot', () => {
  const report = normalizeOpenAICompanion(
    {
      plan_type: 'pro',
      rate_limit: { primary_window: weeklyWindow, secondary_window: null },
    },
    appUsage(),
  )
  assert.equal(report.status, 'plan week 88%')
})

test('OpenAI companion window labels come from duration, never primary/secondary position', () => {
  const report = normalizeOpenAICompanion(
    {
      rate_limit: {
        primary_window: weeklyWindow,
        secondary_window: { ...fiveHourWindow, limit_window_seconds: 86_400 },
      },
    },
    appUsage(),
  )
  assert.equal(report.status, 'plan week 88% · 1d 65%')
  assert.doesNotMatch(report.status, /5h/)
})

test('OpenAI companion app matching rejects incomplete lists, pagination, and malformed identities', () => {
  for (const payload of [
    {},
    { items: [], has_more: true },
    { items: [], next_cursor: 'another-page' },
    { items: [], unexpected_pagination: true },
    { items: [null] },
    { items: [{ id: '' }] },
    { items: [{ id: 123 }] },
    { items: Array.from({ length: 129 }, () => ({ id: 'client' })) },
  ]) {
    assert.throws(() => parseOpenAIAppUsage(payload, 'client'))
  }
  assert.throws(() => parseOpenAIAppUsage({ items: [] }, 'client'), /uniquely/)
})

test('OpenAI app matching selects exactly one registration and rejects duplicate IDs', () => {
  const matching = { id: 'client', windows: [weeklyWindow] }
  const result = parseOpenAIAppUsage(
    {
      items: [{ id: 'other', windows: [{ invalid: true }] }, matching],
      has_more: false,
      next_cursor: null,
    },
    'client',
  )
  assert.equal(result.windows[0]?.label, 'week')
  assert.throws(
    () => parseOpenAIAppUsage({ items: [matching, matching] }, 'client'),
    /uniquely/,
  )
})

test('OpenAI companion windows reject invalid percentages, durations, resets, and contradictions', () => {
  for (const patch of [
    { used_percent: '12' },
    { used_percent: Number.NaN },
    { used_percent: -1 },
    { used_percent: 101 },
    { remaining_percent: 2 },
    { remaining_percent: null },
    { limit_window_seconds: undefined },
    { limit_window_seconds: 0 },
    { limit_window_seconds: 0.5 },
    { reset_at: -1 },
    { reset_at: '1800000000' },
    { reset_at: 8_640_000_000_001 },
  ]) {
    assert.throws(
      () =>
        parseOpenAIAppUsage(
          {
            items: [{ id: 'client', windows: [{ ...weeklyWindow, ...patch }] }],
          },
          'client',
        ),
      /invalid or contradictory/,
    )
    assert.throws(
      () =>
        normalizeOpenAICompanion(
          {
            rate_limit: { primary_window: { ...weeklyWindow, ...patch } },
          },
          appUsage(),
        ),
      /invalid or contradictory/,
    )
  }
})

test('OpenAI companion app windows and allowance are bounded and must be valid', () => {
  for (const windows of [[], null, Array(33).fill(weeklyWindow)]) {
    assert.throws(() =>
      parseOpenAIAppUsage({ items: [{ id: 'client', windows }] }, 'client'),
    )
  }
  for (const allowance of [-1, 101, '50', null]) {
    assert.throws(
      () =>
        parseOpenAIAppUsage(
          {
            items: [
              {
                id: 'client',
                windows: [weeklyWindow],
                allowed_usage_percent: allowance,
              },
            ],
          },
          'client',
        ),
      /invalid allowance/,
    )
  }
  const zero = parseOpenAIAppUsage(
    {
      items: [
        { id: 'client', windows: [weeklyWindow], allowed_usage_percent: 0 },
      ],
    },
    'client',
  )
  assert.equal(zero.allowance, 0)
})

test('OpenAI companion does not invent missing plan windows or Pro weekly windows', () => {
  for (const payload of [
    {},
    { rate_limit: {} },
    { rate_limit: { primary_window: null, secondary_window: null } },
    { plan_type: 'pro', rate_limit: { primary_window: fiveHourWindow } },
  ]) {
    assert.throws(
      () => normalizeOpenAICompanion(payload, appUsage()),
      /no supported windows/,
    )
  }
})

test('OpenAI companion derives remaining percentages without leaking backend app names', () => {
  const app = parseOpenAIAppUsage(
    {
      items: [
        {
          id: 'client',
          name: 'private app name\u001b[31m',
          windows: [
            { ...weeklyWindow, used_percent: 33.3, reset_at: undefined },
          ],
        },
      ],
    },
    'client',
  )
  const report = normalizeOpenAICompanion(
    { rate_limit: { primary_window: { ...weeklyWindow, used_percent: 33.3 } } },
    app,
  )
  assert.equal(report.status, 'plan week 66.7%')
  assert.match(report.lines.join('\n'), /App week: reset time unavailable/)
  assert.doesNotMatch(report.lines.join('\n'), /private app name/)
})

function appUsage() {
  const payload: UnknownRecord = {
    items: [
      {
        id: 'client',
        allowed_usage_percent: 50,
        windows: [fiveHourWindow, weeklyWindow],
      },
    ],
  }
  return parseOpenAIAppUsage(payload, 'client')
}
