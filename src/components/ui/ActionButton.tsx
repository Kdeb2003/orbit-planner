import type { LucideIcon } from 'lucide-react'

interface ActionButtonProps {
  icon: LucideIcon
  label: string
}

/** Placeholder action: visibly disabled so it doesn't pretend to work. */
export function ActionButton({ icon: Icon, label }: ActionButtonProps) {
  return (
    <button
      type="button"
      disabled
      title="Coming soon"
      className="flex min-h-11 w-full cursor-not-allowed items-center gap-3 rounded-xl border border-dashed border-line bg-surface-2/50 px-4 text-sm text-muted"
    >
      <Icon size={18} aria-hidden />
      <span className="flex-1 text-left">{label}</span>
      <span className="text-xs">Soon</span>
    </button>
  )
}
