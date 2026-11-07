import { useEffect, useState, type ReactNode } from 'react'
import { TerminalSquare } from 'lucide-react'
import type { WindowState } from '../../shared/types'
import { useTheme } from '../theme'
import { WallpaperLayer } from './WallpaperLayer'
import './title-bar.css'
import './window-drag.css'

function initialWindowState(): WindowState {
  const agent = navigator.userAgent
  return {
    platform: /Macintosh|Mac OS X/.test(agent) ? 'darwin' : /Linux/.test(agent) ? 'linux' : 'win32',
    maximized: false,
    fullscreen: false,
    focused: true
  }
}

export function TitleBar() {
  const { preset } = useTheme()
  return <header className="window-titlebar app-titlebar" aria-label="Window title bar" title="Drag to move the window. Double-click to maximize or restore.">
    <div className="window-titlebar-content">
      <TerminalSquare className="window-titlebar-icon" size={15} strokeWidth={1.8} aria-hidden="true" />
      <span className="window-titlebar-name">SSH Heaven</span>
      <span className="window-titlebar-theme" aria-label={`Current theme: ${preset.name}`}><span />{preset.name}</span>
    </div>
  </header>
}

export function WindowFrame({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WindowState>(initialWindowState)
  useEffect(() => {
    let active = true
    let receivedEvent = false
    const unsubscribe = window.sshHeaven.onWindowState((next) => {
      receivedEvent = true
      if (active) setState(next)
    })
    void window.sshHeaven.getWindowState().then((next) => {
      if (active && !receivedEvent) setState(next)
    }).catch(() => { /* Native controls stay available if the initial state query fails. */ })
    return () => { active = false; unsubscribe() }
  }, [])

  return <div className="window-frame"
    data-platform={state.platform}
    data-maximized={String(state.maximized)}
    data-fullscreen={String(state.fullscreen)}
    data-focused={String(state.focused)}
  >
    <TitleBar />
    <div className="window-content"><WallpaperLayer />{children}</div>
  </div>
}
