import { FileUp, Loader2, ShieldCheck } from 'lucide-react'
import { useId, useState } from 'react'
import { MAX_PDF_BYTES, formatBytes } from '../../timetable/import/loadTimetable.ts'
import type { LoadProgress, TimetableLoadError } from '../../timetable/import/loadTimetable.ts'
import { Card } from '../ui/Card'
import { Notice, secondaryBtn } from './shared'

export type UploadPhase = { kind: 'idle' } | { kind: 'loading'; progress: LoadProgress } | { kind: 'error'; error: TimetableLoadError }

function progressText(p: LoadProgress): { text: string; value: number | null } {
  switch (p.stage) {
    case 'reading':
      return { text: 'Reading the file…', value: 5 }
    case 'engine':
      return { text: 'Preparing the PDF reader…', value: 10 }
    case 'parsing':
      return { text: `Reading page ${p.page} of ${p.pages}…`, value: 10 + Math.round(((p.page ?? 0) / (p.pages ?? 1)) * 80) }
    default:
      return { text: 'Checking the timetable…', value: 95 }
  }
}

export function UploadStep({ phase, onFile }: { phase: UploadPhase; onFile: (file: File) => void }) {
  const inputId = useId()
  const [dragging, setDragging] = useState(false)
  const loading = phase.kind === 'loading'
  const progress = loading ? progressText(phase.progress) : null

  return (
    <Card title="1 · Choose the timetable PDF">
      <div className="space-y-4">
        <div
          onDragOver={(e) => {
            e.preventDefault()
            if (!loading) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            const file = e.dataTransfer.files[0]
            if (file && !loading) onFile(file)
          }}
          className={`flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed p-6 text-center sm:p-10 ${dragging ? 'border-accent bg-accent/10' : 'border-line bg-surface-2/30'}`}
        >
          <FileUp size={28} className="text-accent-soft" aria-hidden />
          <p className="text-sm text-muted">Pick the UTN semester timetable you downloaded (a PDF, up to {formatBytes(MAX_PDF_BYTES)}), or drop it here.</p>
          <input
            id={inputId}
            type="file"
            accept="application/pdf,.pdf"
            disabled={loading}
            className="peer sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = '' // the same file can be chosen again after an error
              if (file) onFile(file)
            }}
          />
          <label htmlFor={inputId} className={`${secondaryBtn} cursor-pointer peer-focus-visible:ring-2 peer-focus-visible:ring-accent ${loading ? 'pointer-events-none opacity-50' : ''}`}>
            Choose PDF
          </label>
        </div>

        {progress && (
          <div role="status" aria-live="polite" className="space-y-2">
            <p className="flex items-center gap-2 text-sm">
              <Loader2 size={16} className="animate-spin" aria-hidden /> {progress.text}
            </p>
            <progress className="h-2 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-accent [&::-webkit-progress-bar]:bg-surface-2 [&::-webkit-progress-value]:bg-accent" max={100} value={progress.value ?? undefined} aria-label="Reading the PDF" />
          </div>
        )}

        {phase.kind === 'error' && (
          <Notice tone="bad" role="alert" title={phase.error.title}>
            {phase.error.message}
          </Notice>
        )}

        <p className="flex items-start gap-2 text-xs text-muted">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-personal" aria-hidden />
          <span>The PDF is read inside this browser tab. It is not uploaded, not sent to any service and not stored; closing or leaving this page discards it.</span>
        </p>
      </div>
    </Card>
  )
}
