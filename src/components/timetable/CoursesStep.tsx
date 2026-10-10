import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react'
import { useId, useState } from 'react'
import type { CourseChoice, DetectedCourse } from '../../timetable/utn/review.ts'
import { Card } from '../ui/Card'
import { Notice, Pill, primaryBtn } from './shared'

interface Props {
  detected: readonly DetectedCourse[]
  choices: readonly CourseChoice[]
  /** Sessions currently selected per course (after group choice), for the "selected · found" counts. */
  selectedCounts: Readonly<Record<string, number>>
  onChange: (next: CourseChoice[]) => void
  onContinue: () => void
}

function CourseRow({ course, choice, selected, onUpdate }: { course: DetectedCourse; choice: CourseChoice; selected: number; onUpdate: (patch: Partial<CourseChoice>) => void }) {
  const hasGroups = course.groups.length >= 2
  const needsGroup = choice.included && course.groups.length >= 1 && choice.group === null
  const groupName = `group-${course.code}`
  return (
    <li data-course={course.code} className="rounded-xl border border-line bg-surface-2/30 p-3">
      <label className="flex min-h-11 cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={choice.included}
          onChange={(e) => onUpdate({ included: e.target.checked })}
          className="mt-1 size-5 shrink-0 accent-[var(--color-accent)]"
        />
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-medium">{course.name}</span>
          <span className="block break-all text-xs text-muted">
            {course.code} ·{' '}
            <span data-testid={`counts-${course.code}`}>
              {choice.included ? `${selected} selected · ${course.sessionCount} found in PDF` : `${course.sessionCount} found in PDF`}
            </span>
          </span>
        </span>
        {course.category === 'german' && <Pill tone="accent">German</Pill>}
      </label>

      {hasGroups && (
        <fieldset className="mt-2 pl-8">
          <legend className="text-xs text-muted">Which group do you attend?</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {course.groups.map((g) => (
              <label key={g} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm ${choice.group === g ? 'border-accent bg-accent/15' : 'border-line'}`}>
                <input type="radio" name={groupName} checked={choice.group === g} disabled={!choice.included} onChange={() => onUpdate({ group: g })} className="accent-[var(--color-accent)]" />
                Group {g}
              </label>
            ))}
            <label className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm ${choice.group === null ? 'border-accent bg-accent/15' : 'border-line'}`}>
              <input type="radio" name={groupName} checked={choice.group === null} disabled={!choice.included} onChange={() => onUpdate({ group: null })} className="accent-[var(--color-accent)]" />
              Not decided
            </label>
          </div>
        </fieldset>
      )}
      {needsGroup && (
        <p className="mt-2 pl-8 text-xs text-work" data-testid={`group-warning-${course.code}`}>
          {hasGroups ? 'No group chosen: sessions of every group are kept and marked “needs review”; attendance is never assumed.' : `This course prints a group (${course.groups.join(', ')}) on its cards, so its sessions are marked “needs review”.`}
        </p>
      )}
    </li>
  )
}

export function CoursesStep({ detected, choices, selectedCounts, onChange, onContinue }: Props) {
  const [othersOpen, setOthersOpen] = useState(false)
  const othersId = useId()
  const byCode = new Map(choices.map((c) => [c.code, c]))
  const update = (code: string, patch: Partial<CourseChoice>) => onChange(choices.map((c) => (c.code === code ? { ...c, ...patch } : c)))
  const usual = detected.filter((c) => c.recommended)
  const others = detected.filter((c) => !c.recommended)
  const chosen = choices.filter((c) => c.included).length
  const othersPicked = others.filter((c) => byCode.get(c.code)?.included).length

  return (
    <Card title="2 · Courses and groups">
      <div className="space-y-5">
        <p className="text-sm text-muted">
          Tick the courses you attend. Your usual courses are pre-selected, and any other course in this PDF can be added. These choices only apply to this preview; they are not saved to your account.
        </p>

        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Your usual courses</legend>
          <ul className="space-y-2">
            {usual.map((c) => (
              <CourseRow key={c.code} course={c} choice={byCode.get(c.code) as CourseChoice} selected={selectedCounts[c.code] ?? 0} onUpdate={(p) => update(c.code, p)} />
            ))}
          </ul>
        </fieldset>

        {others.length > 0 && (
          <section>
            <h3>
              <button
                type="button"
                aria-expanded={othersOpen}
                aria-controls={othersId}
                onClick={() => setOthersOpen(!othersOpen)}
                className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-line px-3 text-left text-sm font-semibold hover:bg-surface-2"
              >
                {othersOpen ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
                <span className="flex-1">Other courses in this timetable ({others.length})</span>
                {othersPicked > 0 && <span className="text-xs font-normal text-accent-soft">{othersPicked} ticked</span>}
              </button>
            </h3>
            {/* hidden, not unmounted: ticks and group choices live in the page state either way */}
            <ul id={othersId} hidden={!othersOpen} className="mt-2 space-y-2">
              {others.map((c) => (
                <CourseRow key={c.code} course={c} choice={byCode.get(c.code) as CourseChoice} selected={selectedCounts[c.code] ?? 0} onUpdate={(p) => update(c.code, p)} />
              ))}
            </ul>
          </section>
        )}

        {chosen === 0 && <Notice tone="warn">No course is selected, so there is nothing to review yet.</Notice>}

        <div className="flex justify-end">
          <button type="button" className={primaryBtn} disabled={chosen === 0} onClick={onContinue}>
            Review sessions <ArrowRight size={16} aria-hidden />
          </button>
        </div>
      </div>
    </Card>
  )
}
