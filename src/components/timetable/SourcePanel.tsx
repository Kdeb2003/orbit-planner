import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { groupAnomalies } from '../../timetable/utn/review.ts'
import type { ReviewItem, SourceFacts } from '../../timetable/utn/review.ts'
import type { SourceAnomaly } from '../../timetable/utn/types.ts'
import { Card } from '../ui/Card'
import { Notice, Pill } from './shared'
import { anomalyTitle, fullDate, weeksText } from './labels'

const ANOMALY_HINT: Record<string, string> = {
  'no-date': 'Sessions on these days have no date. They cannot be saved unless you enter and confirm a date yourself.',
  'date-weekday-mismatch': 'The printed date does not match the weekday. ORBIT withheld the date instead of guessing; a session on that day needs a date you confirm.',
  'duplicate-date': 'The same date appears under two weekdays. Check the original PDF before trusting sessions on either day.',
}

export function SourcePanel({ fileName, facts, anomalies, items }: { fileName: string; facts: SourceFacts; anomalies: readonly SourceAnomaly[]; items: readonly ReviewItem[] }) {
  const groups = groupAnomalies(anomalies)
  return (
    <Card title="Timetable source">
      <div className="space-y-4">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-xs text-muted">File</dt>
            <dd className="break-words" data-testid="source-file">{fileName}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Status</dt>
            <dd className="flex items-center gap-1.5 text-personal">
              <CheckCircle2 size={16} aria-hidden /> Supported UTN timetable, read locally
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Semester</dt>
            <dd>{facts.semester ?? 'Not printed'}{facts.weeks ? ` · ${facts.weeks} weeks` : ''}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Printed dates</dt>
            <dd>{facts.printedRange ? `${fullDate(facts.printedRange.first)} – ${fullDate(facts.printedRange.last)}` : 'None'}</dd>
          </div>
        </dl>

        {facts.preliminaryNote ? (
          <Notice tone="warn" title="Preliminary timetable">
            “{facts.preliminaryNote}” Re-check the university’s latest version before relying on these sessions.
          </Notice>
        ) : (
          <Notice tone="neutral">No “preliminary” notice was found in this PDF.</Notice>
        )}

        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle size={16} className="text-work" aria-hidden /> Source anomalies
            <Pill tone={groups.length ? 'warn' : 'good'}>{groups.length}</Pill>
          </h3>
          {groups.length === 0 ? (
            <p className="text-sm text-muted">No problems with the dates or week layout were detected.</p>
          ) : (
            <ul className="space-y-2" data-testid="anomalies">
              {groups.map((g) => {
                const affected = items.filter((i) => i.session.date === null && g.semesterWeeks.includes(i.session.semesterWeek)).length
                return (
                  <li key={g.code} data-anomaly={g.code} className="rounded-xl border border-work/30 bg-work/5 p-3 text-sm">
                    <p className="font-medium">
                      {anomalyTitle(g.code)} <span className="font-normal text-muted">· {weeksText(g.semesterWeeks)}</span>
                    </p>
                    <p className="mt-1 text-muted">{g.messages[0]}{g.messages.length > 1 ? ` (+${g.messages.length - 1} similar)` : ''}</p>
                    {ANOMALY_HINT[g.code] && <p className="mt-1 text-muted">{ANOMALY_HINT[g.code]}</p>}
                    <p className="mt-1 text-xs">
                      {affected > 0 ? <span className="text-deadline">{affected} of your selected sessions have no usable date.</span> : <span className="text-muted">None of your currently selected sessions are affected.</span>}
                    </p>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </Card>
  )
}
