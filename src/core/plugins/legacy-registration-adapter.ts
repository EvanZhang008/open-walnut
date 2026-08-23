import type {
  ExtIndexSpec,
  HttpRoute,
  IntegrationSync,
  MigrateFn,
  PluginApi,
  PluginToolSpec,
  ProjectClaimFn,
  DisplayMeta,
} from '../integration-types.js'
import type { SubsystemLogger } from '../../logging/index.js'
import type { WalnutServerPluginApi } from './server-api.js'

export async function createLegacyRegistrationAdapter(
  walnut: WalnutServerPluginApi,
): Promise<PluginApi> {
  const config = await walnut.config.get()
  return {
    id: walnut.pluginId,
    name: walnut.pluginName,
    config,
    logger: walnut.log as unknown as SubsystemLogger,
    registerSync(sync: IntegrationSync) {
      walnut.registry.sync(sync)
    },
    registerSourceClaim(claim: ProjectClaimFn, options?: { priority?: number }) {
      walnut.registry.sourceClaim(claim, options)
    },
    registerDisplay(meta: DisplayMeta) {
      walnut.registry.display(meta)
    },
    registerAgentContext(text: string) {
      walnut.registry.agentContext(text)
    },
    registerMigration(migrate: MigrateFn) {
      walnut.registry.migration(migrate)
    },
    registerHttpRoute(_route: HttpRoute) {
      throw new Error('Legacy Express routes cannot be adapted to the unified Plugin HTTP API')
    },
    registerTool(tool: PluginToolSpec) {
      walnut.registry.tool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema,
        execute(input) { return tool.execute(input) },
      })
    },
    registerExtIndex(spec: ExtIndexSpec) {
      walnut.registry.extIndex(spec)
    },
  }
}
