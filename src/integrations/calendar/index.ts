import { calendarTools } from '../../agent/tools/calendar-tools.js'
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'

export function activate(walnut: WalnutServerPluginApi): void {
  for (const tool of calendarTools) {
    walnut.registry.tool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
      execute: (input) => tool.execute(input),
    })
  }
}
