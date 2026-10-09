import type { ReactNode } from 'react'

interface CardProps {
  title?: string
  action?: ReactNode
  className?: string
  children: ReactNode
}

export function Card({ title, action, className = '', children }: CardProps) {
  return (
    <section className={`rounded-2xl border border-line bg-surface p-4 shadow-lg shadow-black/20 sm:p-5 ${className}`}>
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold tracking-wide text-white">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  )
}
