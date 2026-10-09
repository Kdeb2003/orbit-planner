export function Badge({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent-soft">
      {children}
    </span>
  )
}
