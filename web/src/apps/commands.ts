import { registerOwned, removeOwner } from '@/commands/registry'
import type { RegisteredApp } from './registry'

let lastSignature = ''

export function syncAppCommands(apps: RegisteredApp[]): void {
  const signature = apps.map((app) => `${app.key}\0${app.title}\0${app.path}`).join('\n')
  if (signature === lastSignature) return
  lastSignature = signature
  removeOwner('app')
  for (const app of apps) {
    registerOwned('app', {
      name: `app:${app.key}`,
      description: `Open ${app.title}`,
      type: 'frontend',
      source: 'app',
      execute(context) {
        context.navigate(app.path)
      },
    })
  }
}

export function resetAppCommandsForTesting(): void {
  lastSignature = ''
  removeOwner('app')
}
