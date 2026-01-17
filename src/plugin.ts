import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { loadConfig, parseModel } from "./config"
import { createLogger } from "./log"

interface SessionState {
  fallbackActive: boolean
  cooldownEndTime: number
}

const sessionStates = new Map<string, SessionState>()

function createPatternMatcher(patterns: string[]) {
  return (message: string): boolean => {
    const lower = message.toLowerCase()
    return patterns.some(pattern => lower.includes(pattern.toLowerCase()))
  }
}

export async function createPlugin(context: PluginInput): Promise<Hooks> {
  const config = loadConfig()
  const logger = createLogger(config.logging)
  const isRateLimitMessage = createPatternMatcher(config.patterns)
  const fallbackModel = parseModel(config.fallbackModel)

  await logger.info("Plugin initialized", {
    enabled: config.enabled,
    fallbackModel: config.fallbackModel,
    patterns: config.patterns,
    cooldownMs: config.cooldownMs,
  })

  if (!config.enabled) {
    await logger.info("Plugin disabled via config")
    return {}
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.status") {
        const props = event.properties as {
          sessionID: string
          status: {
            type: "idle" | "retry" | "busy"
            attempt?: number
            message?: string
            next?: number
          }
        }

        if (props.status.type === "retry" && props.status.message) {
          if (isRateLimitMessage(props.status.message)) {
            const sessionID = props.sessionID
            const existingState = sessionStates.get(sessionID)

            if (existingState?.fallbackActive && Date.now() < existingState.cooldownEndTime) {
              await logger.info("Skipping fallback, cooldown active", {
                sessionID,
                cooldownRemaining: existingState.cooldownEndTime - Date.now(),
              })
              return
            }

            await logger.info("Rate limit detected, switching to fallback", {
              sessionID,
              message: props.status.message,
              fallbackModel: config.fallbackModel,
            })

            sessionStates.set(sessionID, {
              fallbackActive: true,
              cooldownEndTime: Date.now() + config.cooldownMs,
            })

            try {
              await context.client.session.abort({
                path: { id: sessionID },
              })

              await new Promise(resolve => setTimeout(resolve, 100))

              await context.client.session.prompt({
                path: { id: sessionID },
                body: {
                  model: fallbackModel,
                  parts: [{ type: "text", text: "continue" }],
                },
              })

              await logger.info("Fallback prompt sent successfully", { sessionID })
            } catch (err) {
              await logger.error("Failed to send fallback prompt", {
                sessionID,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }
        }

        if (props.status.type === "idle") {
          const sessionID = props.sessionID
          const state = sessionStates.get(sessionID)
          if (state && state.fallbackActive && Date.now() >= state.cooldownEndTime) {
            state.fallbackActive = false
            await logger.info("Cooldown expired, fallback reset", { sessionID })
          }
        }
      }

      if (event.type === "session.deleted") {
        const props = event.properties as { info?: { id?: string } }
        if (props.info?.id) {
          sessionStates.delete(props.info.id)
          await logger.info("Session cleaned up", { sessionID: props.info.id })
        }
      }
    },
  }
}
