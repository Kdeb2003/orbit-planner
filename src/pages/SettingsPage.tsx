import { Globe, Smartphone } from 'lucide-react'
import { Card } from '../components/ui/Card'
import { AccountCard } from '../components/AccountCard'
import { LocalImportCard } from '../components/LocalImportCard'
import { ComingSoon } from '../components/ui/ComingSoon'
import { PageHeader } from '../components/ui/PageHeader'
import { TIME_ZONE } from '../utils/time'

export function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" subtitle="Preferences and sync." />
      <AccountCard />
      <LocalImportCard />
      <Card title="General">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="flex items-center gap-2 text-muted">
            <Globe size={16} aria-hidden /> Time zone
          </span>
          <span>{TIME_ZONE}</span>
        </div>
      </Card>
      <ComingSoon icon={Smartphone} title="Install as app" description="Progressive Web App support." />
    </div>
  )
}
