import { Component, type ErrorInfo, type ReactNode } from 'react'
import { log } from '@/utils/log'

interface PluginBoundaryProps {
  pluginId: string
  pluginName: string
  resetKey: number
  children: ReactNode
  compact?: boolean
  fallback?: ReactNode
}

interface PluginBoundaryState {
  error: Error | null
}

export class PluginBoundary extends Component<PluginBoundaryProps, PluginBoundaryState> {
  state: PluginBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): PluginBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error('plugins', 'native Web Plugin render failed', {
      pluginId: this.props.pluginId,
      error: error.stack ?? error.message,
      componentStack: info.componentStack ?? undefined,
    })
  }

  componentDidUpdate(previous: PluginBoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    if (this.props.fallback !== undefined) return this.props.fallback
    return (
      <div className={`plugin-error-boundary${this.props.compact ? ' plugin-error-boundary-compact' : ''}`}>
        <strong>{this.props.pluginName} failed to render</strong>
        <span>{this.state.error.message}</span>
      </div>
    )
  }
}
