import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { loadConfig, parseModel, type FallbackModel, type FallbackModelObject } from "./config"
import { createLogger } from "./log"

interface SessionState {
  fallbackActive: boolean
  cooldownEndTime: number
  attemptCount: number
  lastUsedModelIndex: number
}

interface MessageInfo {
  id: string
  role: "user" | "assistant"
  sessionID: string
  model?: {
    providerID: string
    modelID: string
  }
  agent?: string
}

interface MessagePart {
  id: string
  type: string
  text?: string
  mime?: string
  filename?: string
  url?: string
  name?: string
}

interface MessageWithParts {
  info: MessageInfo
  parts: MessagePart[]
}

interface PromptBody {
  agent?: string
  parts: Array<{ type: "text"; text: string } | { type: "file"; mime: string; filename?: string; url: string } | { type: "agent"; name: string }>
  model?: FallbackModelObject
}

const sessionStates = new Map<string, SessionState>()

function normalizeFallbackModels(config: FallbackModel | FallbackModel[]): FallbackModelObject[] {
  const models = Array.isArray(config) ? config : [config]
  return models.map(model => parseModel(model))
}

function getNextFallbackModel(
  fallbackModels: FallbackModelObject[],
  attemptCount: number
): { model: FallbackModelObject | null; shouldUseMain: boolean } {
  // Rotation pattern:
  // attempt 1: fallback[0]
  // attempt 2: main
  // attempt 3: fallback[0]
  // attempt 4: fallback[1]
  // attempt 5: fallback[2]
  // ... continue through all fallbacks
  
  // Edge case: if attemptCount is 0 or less, default to fallback[0]
  if (attemptCount <= 0) {
    return { model: fallbackModels[0], shouldUseMain: false }
  }
  
  if (attemptCount === 1) {
    // First fallback: try fallback[0]
    return { model: fallbackModels[0], shouldUseMain: false }
  }
  
  if (attemptCount === 2) {
    // Second attempt: try main again
    return { model: null, shouldUseMain: true }
  }
  
  if (attemptCount === 3) {
    // Third attempt: try fallback[0] again
    return { model: fallbackModels[0], shouldUseMain: false }
  }
  
  // For attempts >= 4, cycle through remaining fallbacks
  // attempt 4 -> fallback[1], attempt 5 -> fallback[2], etc.
  const fallbackIndex = attemptCount - 3
  if (fallbackIndex < fallbackModels.length) {
    return { model: fallbackModels[fallbackIndex], shouldUseMain: false }
  }
  
  // If we've exhausted all fallbacks, keep using the last one
  return { model: fallbackModels[fallbackModels.length - 1], shouldUseMain: false }
}

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
  const fallbackModels = normalizeFallbackModels(config.fallbackModel)

  await logger.info("Plugin initialized", {
    enabled: config.enabled,
    fallbackModel: config.fallbackModel,
    fallbackModelsCount: fallbackModels.length,
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
            let state = sessionStates.get(sessionID)

            if (state?.fallbackActive && Date.now() < state.cooldownEndTime) {
              await logger.info("Skipping fallback, cooldown active", {
                sessionID,
                cooldownRemaining: state.cooldownEndTime - Date.now(),
              })
              return
            }

            // Initialize or increment attempt count
            if (!state) {
              state = {
                fallbackActive: true,
                cooldownEndTime: Date.now() + config.cooldownMs,
                attemptCount: 1,
                lastUsedModelIndex: -1,
              }
              sessionStates.set(sessionID, state)
            } else {
              state.attemptCount += 1
              state.fallbackActive = true
              state.cooldownEndTime = Date.now() + config.cooldownMs
            }

            // Determine which model to use based on attempt count
            const { model: nextModel, shouldUseMain } = getNextFallbackModel(
              fallbackModels,
              state.attemptCount
            )

            await logger.info("Rate limit detected, switching to fallback", {
              sessionID,
              message: props.status.message,
              attemptCount: state.attemptCount,
              shouldUseMain,
              nextModel: shouldUseMain ? "main" : nextModel,
            })

            try {
              await logger.info("Aborting session", { sessionID })
              await context.client.session.abort({ path: { id: sessionID } })
              await new Promise(resolve => setTimeout(resolve, 200))

              await logger.info("Fetching messages", { sessionID })
              const messagesResponse = await context.client.session.messages({ path: { id: sessionID } })
              const messages = messagesResponse.data as MessageWithParts[] | undefined

              if (!messages || messages.length === 0) {
                await logger.error("No messages found in session", { sessionID })
                return
              }

              const lastUserMessage = [...messages].reverse().find(m => m.info.role === "user")
              if (!lastUserMessage) {
                await logger.error("No user message found in session", { sessionID })
                return
              }

              await logger.info("Found last user message", {
                sessionID,
                messageId: lastUserMessage.info.id,
                totalMessages: messages.length,
              })

              await logger.info("Reverting session", { sessionID, messageId: lastUserMessage.info.id })
              const revertResponse = await context.client.session.revert({
                path: { id: sessionID },
                body: { messageID: lastUserMessage.info.id },
              })
              await logger.info("Revert completed", {
                sessionID,
                revertStatus: revertResponse.response?.status,
                hasRevertState: !!(revertResponse.data as any)?.revert,
              })
              await new Promise(resolve => setTimeout(resolve, 500))

              const originalParts = lastUserMessage.parts
                .filter(p => !isSyntheticPart(p))
                .map(p => convertToPromptPart(p))
                .filter((p): p is NonNullable<typeof p> => p !== null)

              if (originalParts.length === 0) {
                await logger.error("No valid parts found in user message", { sessionID })
                return
              }

              await logger.info("Sending prompt with fallback model", {
                sessionID,
                model: shouldUseMain ? "main" : nextModel,
                partsCount: originalParts.length,
                attemptCount: state.attemptCount,
              })
              
              // Build the prompt body
              const promptBody: PromptBody = {
                agent: lastUserMessage.info.agent,
                parts: originalParts,
              }
              
              // Only specify model if not using main
              if (!shouldUseMain && nextModel) {
                promptBody.model = nextModel
              }
              
              await context.client.session.prompt({
                path: { id: sessionID },
                body: promptBody,
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
            // Reset state when cooldown expires and session is idle
            state.fallbackActive = false
            state.attemptCount = 0
            state.lastUsedModelIndex = -1
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

function isSyntheticPart(part: MessagePart): boolean {
  return (part as any).synthetic === true
}

function convertToPromptPart(part: MessagePart): { type: "text"; text: string } | { type: "file"; mime: string; filename?: string; url: string } | { type: "agent"; name: string } | null {
  switch (part.type) {
    case "text":
      if (part.text) {
        return { type: "text", text: part.text }
      }
      return null
    case "file":
      if (part.url && part.mime) {
        return { type: "file", mime: part.mime, filename: part.filename, url: part.url }
      }
      return null
    case "agent":
      if (part.name) {
        return { type: "agent", name: part.name }
      }
      return null
    default:
      return null
  }
}
