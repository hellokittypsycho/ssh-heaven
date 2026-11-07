import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function Modal({ title, children, onClose, className = '' }: {
  title: string
  children: ReactNode
  onClose: () => void
  className?: string
}) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const isTopDialog = () => [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].at(-1) === dialog.current
    const focusDefault = () => {
      const target = dialog.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? dialog.current?.querySelector<HTMLElement>('button:not(:disabled)')
      target?.focus()
    }
    const frame = requestAnimationFrame(() => {
      if (isTopDialog() && !dialog.current?.contains(document.activeElement)) focusDefault()
    })
    const keepFocus = (event: FocusEvent) => {
      if (isTopDialog() && event.target instanceof Node && !dialog.current?.contains(event.target)) focusDefault()
    }
    const handle = (event: KeyboardEvent) => {
      if (!isTopDialog()) return
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      if (event.key !== 'Tab' || !dialog.current) return
      const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', handle)
    document.addEventListener('focusin', keepFocus)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', handle); document.removeEventListener('focusin', keepFocus); previous?.focus() }
  }, [onClose])
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={dialog} className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-header"><h2>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>
      {children}
    </div>
  </div>
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').replace(/^Error: /, '')
}
