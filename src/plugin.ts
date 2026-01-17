import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { loadConfig, type RateLimitFallbackConfig } from "./config"

const RATE_LIMIT_MESSAGES = [
  "rate limit",
  "usage limit",
  "too many requests",
  "quota exceeded",
  "overloaded",
]

interface SessionState {
  fallbackActive: boolean
  cooldownEndTime: number
}

const sessionStates = new Map<string, SessionState>()

function isRateLimitMessage(message: string): boolean {
  const lower = message.toLowerCase()
  return RATE_LIMIT_MESSAGES.some(pattern => lower.includes(pattern))
}

export async function createPlugin(context: PluginInput): Promise<Hooks> {
  const config = loadConfig()

  if (!config.enabled) {
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
              return
            }

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
                  model: config.fallbackModel,
                  parts: [{ type: "text", text: "continue" }],
                },
              })
            } catch {}
          }
        }

        if (props.status.type === "idle") {
          const sessionID = props.sessionID
          const state = sessionStates.get(sessionID)
          if (state && state.fallbackActive && Date.now() >= state.cooldownEndTime) {
            state.fallbackActive = false
          }
        }
      }

      if (event.type === "session.deleted") {
        const props = event.properties as { info?: { id?: string } }
        if (props.info?.id) {
          sessionStates.delete(props.info.id)
        }
      }
    },
  }
}
