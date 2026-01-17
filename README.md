# opencode-rate-limit-fallback

OpenCode plugin that automatically switches to a fallback model when rate limits are hit.

## Installation

Add to your `opencode.jsonc`:

```json
{
  "plugin": ["opencode-rate-limit-fallback"]
}
```

## Configuration

Create `rate-limit-fallback.json` in your OpenCode config directory:

**Locations checked (in order):**
1. `~/.config/opencode/rate-limit-fallback.json`
2. `~/.config/opencode/config/rate-limit-fallback.json`
3. `~/.config/opencode/plugins/rate-limit-fallback.json`
4. `~/.config/opencode/plugin/rate-limit-fallback.json`

**Example config:**

```json
{
  "enabled": true,
  "fallbackModel": {
    "providerID": "anthropic",
    "modelID": "claude-opus-4-5"
  },
  "cooldownMs": 300000
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `fallbackModel.providerID` | string | `"anthropic"` | Provider for fallback model |
| `fallbackModel.modelID` | string | `"claude-opus-4-5"` | Model ID for fallback |
| `cooldownMs` | number | `300000` | Cooldown period in ms (default: 5 minutes) |

## How It Works

1. **Detection**: Listens for `session.status` events with retry messages containing rate limit keywords:
   - "rate limit"
   - "usage limit"
   - "too many requests"
   - "quota exceeded"
   - "overloaded"

2. **Fallback**: When detected:
   - Aborts the current retry loop
   - Sends a "continue" prompt with the fallback model
   - Starts a cooldown timer

3. **Cooldown**: During the cooldown period, subsequent rate limits on the same session are ignored (prevents spam). After cooldown expires, normal model selection resumes.

## License

MIT
