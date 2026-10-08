import type { Api, Model } from '@earendil-works/pi-ai'
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import {
  getSupportedProviders,
  queryUsage,
  renderReport,
  renderStatus,
} from './usage.ts'

const STATUS_KEY = 'pi-usage'
const REFRESH_INTERVAL_MS = 5 * 60 * 1000

export default function piUsageExtension(pi: ExtensionAPI): void {
  let sessionActive = false
  let statusRequest = 0
  let refreshTimer: ReturnType<typeof setTimeout> | undefined

  function clearTimer() {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
    }
    refreshTimer = undefined
  }

  function setStatus(ctx: ExtensionContext, value: string | undefined): void {
    if (!ctx.hasUI) {
      return
    }
    try {
      ctx.ui.setStatus(STATUS_KEY, value)
    } catch {
      // A status update can race with session replacement or extension reload.
    }
  }

  async function updateCurrentStatus(ctx: ExtensionContext): Promise<void> {
    const request = ++statusRequest
    clearTimer()

    if (!sessionActive || !ctx.model) {
      setStatus(ctx, undefined)
      return
    }

    const provider = ctx.model.provider
    if (!getSupportedProviders().some((item) => item.id === provider)) {
      setStatus(ctx, undefined)
      return
    }

    setStatus(ctx, 'usage…')
    try {
      const report = await queryUsage(ctx, ctx.model)
      if (!sessionActive || request !== statusRequest) {
        return
      }
      setStatus(ctx, renderStatus(report))
    } catch {
      if (!sessionActive || request !== statusRequest) {
        return
      }
      setStatus(ctx, 'usage unavailable')
    }

    if (sessionActive && request === statusRequest) {
      refreshTimer = setTimeout(() => {
        if (sessionActive) {
          void updateCurrentStatus(ctx)
        }
      }, REFRESH_INTERVAL_MS)
      refreshTimer.unref?.()
    }
  }

  pi.registerCommand('usage', {
    description:
      'Show subscription quotas or API usage for the active provider',
    handler: async (args, ctx) => {
      const requested = args.trim()
      const currentModel = ctx.model
      let model: Model<Api> | undefined

      if (requested) {
        const wanted = requested.toLowerCase()
        const provider = getSupportedProviders().find(
          (item) => item.id === wanted || item.aliases?.includes(wanted),
        )
        if (!provider) {
          ctx.ui.notify(
            `Unknown provider "${requested}". Run /usage without an argument to see available providers.`,
            'warning',
          )
          return
        }
        model = findProviderModel(ctx, provider.id)
        if (!model) {
          ctx.ui.notify(
            `No Pi model is configured for ${provider.name}.`,
            'warning',
          )
          return
        }
      } else if (
        currentModel &&
        getSupportedProviders().some(
          (item) => item.id === currentModel.provider,
        )
      ) {
        model = currentModel
      } else {
        const configured = getConfiguredProviders(ctx)
        if (!configured.length) {
          ctx.ui.notify(
            'No supported provider model is configured. See the provider list in the plugin README.',
            'warning',
          )
          return
        }
        if (!ctx.hasUI || configured.length === 1) {
          model = configured[0]?.model
        } else {
          const selected = await ctx.ui.select(
            'Choose a configured provider',
            configured.map((entry) => entry.name),
          )
          if (!selected) {
            return
          }
          model = configured.find((entry) => entry.name === selected)?.model
        }
      }

      if (!model) {
        return
      }
      try {
        const report = await queryUsage(ctx, model)
        ctx.ui.notify(renderReport(report), 'info')
        if (ctx.model?.provider === model.provider) {
          setStatus(ctx, renderStatus(report))
        }
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error
            ? error.message
            : 'Usage could not be retrieved.',
          'warning',
        )
      }
    },
  })

  pi.on('session_start', (_event, ctx) => {
    sessionActive = true
    void updateCurrentStatus(ctx)
  })

  pi.on('model_select', (_event, ctx) => {
    if (sessionActive) {
      void updateCurrentStatus(ctx)
    }
  })

  pi.on('session_shutdown', () => {
    sessionActive = false
    statusRequest += 1
    clearTimer()
  })
}

function findProviderModel(
  ctx: ExtensionContext,
  providerId: string,
): Model<Api> | undefined {
  if (ctx.model?.provider === providerId) {
    return ctx.model
  }
  const models = [
    ...ctx.modelRegistry.getAvailable(),
    ...ctx.modelRegistry.getAll(),
  ]
  return models.find((model) => model.provider === providerId)
}

function getConfiguredProviders(
  ctx: ExtensionContext,
): Array<{ id: string; name: string; model: Model<Api> }> {
  const models = [
    ...ctx.modelRegistry.getAvailable(),
    ...ctx.modelRegistry.getAll(),
  ]
  const configured: Array<{ id: string; name: string; model: Model<Api> }> = []
  for (const provider of getSupportedProviders()) {
    if (ctx.model?.provider === provider.id) {
      configured.push({ ...provider, model: ctx.model })
      continue
    }
    const model = models.find((candidate) => candidate.provider === provider.id)
    if (model) {
      configured.push({ ...provider, model })
    }
  }
  return configured
}
