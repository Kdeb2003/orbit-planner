// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAuthController } from '../../auth/authController'
import { AuthProvider } from '../../auth/AuthProvider'
import { createFakeAuthClient, fakeSession } from '../../auth/fakeAuthClient'
import { CalendarProvider } from '../../calendar/CalendarProvider'
import { useCalendar } from '../../calendar/CalendarContext'
import { FakeCloud } from '../../cloud/fakeCloudApi'
import raw from '../../timetable/utn/__fixtures__/utn-wise2627-layouts.json?raw'
import { FakeImportApi } from '../../timetable/save/fakeImportApi'
import { extractFromLayouts } from '../../timetable/utn/index'
import { buildReview, initialState } from '../../timetable/utn/review'
import type { SourceFacts } from '../../timetable/utn/review'
import type { PageLayout } from '../../timetable/utn/types'
import { SaveCard } from './SaveCard'

// Mocked backends (FakeCloud + FakeImportApi). The real SQL contract is verified in supabase/tests/save-import.test.ts.
const USER = fakeSession.user.id
let result: ReturnType<typeof buildReview>
let choices: ReturnType<typeof initialState>['choices']
let importable = 0
const facts: SourceFacts = { semester: 'Winter Semester 2026/2027', preliminaryNote: null, weeks: 1, printedRange: null }
const file = { arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 test bytes').buffer } as unknown as File

beforeAll(() => {
  const sessions = extractFromLayouts(structuredClone((JSON.parse(raw) as { pages: PageLayout[] }).pages)).sessions
  const state = initialState(sessions)
  result = buildReview(sessions, state)
  choices = state.choices
  importable = result.items.filter((i) => i.state === 'ready').length
})
afterEach(cleanup)

function Probe() {
  const c = useCalendar()
  return <p data-testid="calendar-count">{c.events.length}</p>
}

function mount(cloud: FakeCloud, imports: FakeImportApi | null) {
  const f = createFakeAuthClient(fakeSession)
  render(
    <MemoryRouter>
      <AuthProvider controller={createAuthController(f.client, { redirectTo: 'http://localhost/' })}>
        <CalendarProvider createApi={(id) => cloud.apiFor(id)} createImportApi={() => imports}>
          <SaveCard file={file} result={result} facts={facts} choices={choices} />
          <Probe />
        </CalendarProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

const phase = () => screen.getByTestId('save-card').getAttribute('data-phase')
const idle = () => waitFor(() => expect(phase()).toBe('idle'))
const review = async () => {
  fireEvent.click(await screen.findByTestId('save-plan-btn'))
  return screen.findByTestId('save-confirm')
}

describe('Confirm & Save card (mocked backend)', () => {
  it('without a cloud account it offers nothing to click', async () => {
    mount(new FakeCloud(), null)
    expect(await screen.findByTestId('save-needs-account')).toBeTruthy()
    expect(screen.queryByTestId('save-plan-btn')).toBeNull()
  })

  it('a server without the import feature is reported, with no save button and no write', async () => {
    const cloud = new FakeCloud()
    const imports = new FakeImportApi(cloud, USER)
    imports.available = false
    mount(cloud, imports)
    expect(await screen.findByTestId('save-unavailable')).toBeTruthy()
    expect(screen.queryByTestId('save-plan-btn')).toBeNull()
    expect(screen.queryByTestId('save-confirm-btn')).toBeNull()
    expect(imports.calls.filter((c) => c !== 'probe')).toEqual([])
    expect(cloud.events.get(USER) ?? []).toHaveLength(0)
  })

  it('shows a loading state while the calendar is checked, then the exact counts; nothing is saved before the confirmation', async () => {
    const cloud = new FakeCloud()
    const imports = new FakeImportApi(cloud, USER)
    mount(cloud, imports)
    await idle()
    cloud.holdResponses()
    fireEvent.click(screen.getByTestId('save-plan-btn'))
    await waitFor(() => expect(phase()).toBe('planning'))
    expect(screen.getByTestId('save-planning')).toBeTruthy()
    cloud.releaseResponses()
    const panel = await screen.findByTestId('save-confirm')
    expect(panel.getAttribute('data-to-create')).toBe(String(importable))
    expect(panel.getAttribute('data-already')).toBe('0')
    expect(panel.getAttribute('data-skipped')).toBe(String(result.items.length - importable))
    expect(screen.getByTestId('save-count-create').textContent).toBe(String(importable))
    expect(imports.calls).not.toContain('createBatch')
    expect(imports.calls).not.toContain('importSessions')
    expect(cloud.events.get(USER) ?? []).toHaveLength(0)
  })

  it('Confirm saves through the import API, shows verified success, and refreshes the calendar', async () => {
    const cloud = new FakeCloud()
    const imports = new FakeImportApi(cloud, USER)
    mount(cloud, imports)
    await idle()
    await waitFor(() => expect(screen.getByTestId('calendar-count').textContent).toBe('0'))
    await review()
    fireEvent.click(screen.getByTestId('save-confirm-btn'))
    const done = await screen.findByTestId('save-result', {}, { timeout: 5000 })
    expect(done.getAttribute('data-kind')).toBe('verified')
    expect(done.textContent).toMatch(/Saved and verified/)
    expect(imports.batches.map((b) => b.status)).toEqual(['verified'])
    expect(imports.batches[0].planned_count).toBe(importable)
    expect(cloud.events.get(USER)).toHaveLength(importable)
    await waitFor(() => expect(screen.getByTestId('calendar-count').textContent).toBe(String(importable))) // the calendar was refreshed
  })

  it('saving the identical PDF again creates nothing: "nothing new", no confirm button, no new batch', async () => {
    const cloud = new FakeCloud()
    const imports = new FakeImportApi(cloud, USER)
    mount(cloud, imports)
    await idle()
    await review()
    fireEvent.click(screen.getByTestId('save-confirm-btn'))
    await screen.findByTestId('save-result', {}, { timeout: 5000 })
    await act(async () => {})
    // plan again (a second visit to the summary step)
    cleanup()
    mount(cloud, imports)
    await idle()
    const panel = await review()
    expect(panel.getAttribute('data-to-create')).toBe('0')
    expect(panel.getAttribute('data-already')).toBe(String(importable))
    expect(screen.getByTestId('save-nothing-new')).toBeTruthy()
    expect(screen.queryByTestId('save-confirm-btn')).toBeNull()
    expect(imports.batches).toHaveLength(1)
    expect(cloud.events.get(USER)).toHaveLength(importable)
  })

  it('a failure midway shows what was saved and a Retry that sends only the missing sessions into the same batch', async () => {
    const cloud = new FakeCloud()
    const imports = new FakeImportApi(cloud, USER)
    imports.failChunk = 2
    mount(cloud, imports)
    await idle()
    await review()
    fireEvent.click(screen.getByTestId('save-confirm-btn'))
    const failed = await screen.findByTestId('save-result', {}, { timeout: 5000 })
    expect(failed.getAttribute('data-kind')).toBe('failed')
    expect(failed.getAttribute('data-created')).toBe('50')
    expect(failed.textContent).toMatch(/not saved twice|nothing is saved twice/i)
    expect(imports.batches.map((b) => b.status)).toEqual(['failed'])
    expect(cloud.events.get(USER)).toHaveLength(50)

    imports.failChunk = null
    const sentBefore = imports.calls.filter((c) => c === 'importSessions').length
    fireEvent.click(screen.getByTestId('save-retry-btn'))
    await waitFor(() => expect(screen.getByTestId('save-result').getAttribute('data-kind')).toBe('verified'), { timeout: 5000 })
    expect(imports.calls.filter((c) => c === 'importSessions').length - sentBefore).toBe(1) // one more chunk: just the 10 missing
    expect(cloud.events.get(USER)).toHaveLength(importable)
    expect(imports.batches).toHaveLength(1)
    expect(imports.batches[0].status).toBe('verified')
    expect(imports.links).toHaveLength(importable)
  })

  it('a verification the server refuses is never shown as saved correctly', async () => {
    const cloud = new FakeCloud()
    const imports = new FakeImportApi(cloud, USER)
    imports.failStatus = 'verified'
    mount(cloud, imports)
    await idle()
    await review()
    fireEvent.click(screen.getByTestId('save-confirm-btn'))
    const res = await screen.findByTestId('save-result', {}, { timeout: 5000 })
    expect(res.getAttribute('data-kind')).toBe('failed')
    expect(screen.queryByText(/Saved and verified/)).toBeNull()
  })

  it('an import running on another device is not raced', async () => {
    const cloud = new FakeCloud()
    const imports = new FakeImportApi(cloud, USER)
    mount(cloud, imports)
    await idle()
    // another tab started a batch for the same timetable a moment ago
    const slug = result.items.find((i) => i.state === 'ready')!.session.sourceKey.split('|')[0]
    await imports.createBatch({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', source_slug: slug, source_sha256: 'b'.repeat(64), planned_count: 3 })
    const panel = await review()
    expect(screen.getByTestId('save-active-elsewhere')).toBeTruthy()
    expect(screen.queryByTestId('save-confirm-btn')).toBeNull()
    expect(panel.getAttribute('data-to-create')).toBe(String(importable))
    expect(cloud.events.get(USER) ?? []).toHaveLength(0)
  })
})
