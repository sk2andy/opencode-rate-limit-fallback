import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface RateLimitFallbackConfig {
  enabled: boolean
  fallbackModel: {
    providerID: string
    modelID: string
  }
  cooldownMs: number
}

const DEFAULT_CONFIG: RateLimitFallbackConfig = {
  enabled: true,
  fallbackModel: {
    providerID: "anthropic",
    modelID: "claude-opus-4-5",
  },
  cooldownMs: 300000,
}

const CONFIG_FILENAME = "rate-limit-fallback.json"

const SEARCH_SUBDIRS = ["config", "plugins", "plugin"]

function getConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming")
    return join(appData, "opencode")
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(xdgConfig, "opencode")
}

function findConfigFile(): string | null {
  const configDir = getConfigDir()

  const rootPath = join(configDir, CONFIG_FILENAME)
  if (existsSync(rootPath)) {
    return rootPath
  }

  for (const subdir of SEARCH_SUBDIRS) {
    const subdirPath = join(configDir, subdir, CONFIG_FILENAME)
    if (existsSync(subdirPath)) {
      return subdirPath
    }
  }

  return null
}

export function loadConfig(): RateLimitFallbackConfig {
  const configPath = findConfigFile()

  if (!configPath) {
    return DEFAULT_CONFIG
  }

  try {
    const content = readFileSync(configPath, "utf-8")
    const userConfig = JSON.parse(content) as Partial<RateLimitFallbackConfig>

    return {
      enabled: userConfig.enabled ?? DEFAULT_CONFIG.enabled,
      fallbackModel: {
        providerID: userConfig.fallbackModel?.providerID ?? DEFAULT_CONFIG.fallbackModel.providerID,
        modelID: userConfig.fallbackModel?.modelID ?? DEFAULT_CONFIG.fallbackModel.modelID,
      },
      cooldownMs: userConfig.cooldownMs ?? DEFAULT_CONFIG.cooldownMs,
    }
  } catch {
    return DEFAULT_CONFIG
  }
}
