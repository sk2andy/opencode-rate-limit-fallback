export { createPlugin as RateLimitFallbackPlugin } from "./src/plugin"
export {
  loadConfig,
  parseModel,
  type RateLimitFallbackConfig,
  type FallbackModel,
  type FallbackModelObject,
} from "./src/config"
export { log, createLogger } from "./src/log"

import { createPlugin } from "./src/plugin"
export default createPlugin
