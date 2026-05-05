import { Component, type ErrorInfo, type ReactNode } from 'react'
import styles from './ErrorBoundary.module.css'

interface Props {
  children: ReactNode
  label?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('ErrorBoundary caught:', this.props.label ?? '(unlabeled)', error, info)
  }

  reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className={styles.container}>
        <div className={styles.message}>
          <div className={styles.title}>This pane crashed</div>
          <div className={styles.detail}>{error.message || String(error)}</div>
          <button className={styles.reload} onClick={this.reset}>
            Reload pane
          </button>
        </div>
      </div>
    )
  }
}
