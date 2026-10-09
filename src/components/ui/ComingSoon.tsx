import type { LucideIcon } from 'lucide-react'
import { Badge } from './Badge'
import { Card } from './Card'

interface ComingSoonProps {
  icon: LucideIcon
  title: string
  description: string
}

export function ComingSoon({ icon: Icon, title, description }: ComingSoonProps) {
  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="rounded-xl bg-accent/15 p-2.5 text-accent-soft">
          <Icon size={20} aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-medium">{title}</h2>
            <Badge>Coming soon</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">{description}</p>
        </div>
      </div>
    </Card>
  )
}
