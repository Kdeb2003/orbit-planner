import { describe, expect, it } from 'vitest'
import { parseCardLines, parseLocation, parseTypeText } from './cardText.ts'

// Every `lines` array below is the literal text of a card in the UTN WiSe 2026/27 timetable.
describe('parseCardLines (real cards)', () => {
  it('AI tutorial group B: code, type/group, programme, room', () => {
    const p = parseCardLines(['W26M-AINBA', 'tutorial group B', 'AIR1', 'NOP / ALC2'])
    expect(p.courseCodes).toEqual(['W26M-AINBA'])
    expect(p.typeText).toBe('tutorial group B')
    expect(p.programs).toEqual(['AIR1'])
    expect(p.location).toEqual({ kind: 'room', campus: 'NOP', room: 'ALC2', raw: 'NOP / ALC2' })
    expect(p.issues).toEqual([])
  })

  it('joins a wrapped room list ("…, Event" + "Space")', () => {
    const p = parseCardLines(['W26M-DENBA', 'main', 'AIR1', 'NOP / ALC1, ALC2, Event', 'Space'])
    expect(p.location?.raw).toBe('NOP / ALC1, ALC2, Event Space')
    expect(p.typeText).toBe('main')
  })

  it('two programmes on one line', () => {
    expect(parseCardLines(['W26M-NLUAD', 'tutorial', 'AIR3, HAI3', 'UL / S32']).programs).toEqual(['AIR3', 'HAI3'])
  })

  it('German A2 has no type and no programme line; the location is "online"', () => {
    const p = parseCardLines(['W26M-Deutsch A2', 'online'])
    expect(p.courseCodes).toEqual(['W26M-Deutsch A2'])
    expect(p.typeText).toBe('')
    expect(p.programs).toEqual([])
    expect(p.location).toEqual({ kind: 'online', raw: 'online' })
    expect(p.issues).toEqual([])
  })

  it('German A1.1 keeps its group text and room', () => {
    const p = parseCardLines(['W26M-Deutsch A1.1', 'group A', 'UL / S31'])
    expect(p.courseCodes).toEqual(['W26M-Deutsch A1.1'])
    expect(p.typeText).toBe('group A')
    expect(p.location?.room).toBe('S31')
  })

  it('a joint card prints two course codes', () => {
    const p = parseCardLines(['W26M-REGEL', 'W26M-ETHIN', 'excursion', 'AIR3, HAI3'])
    expect(p.courseCodes).toEqual(['W26M-REGEL', 'W26M-ETHIN'])
    expect(p.typeText).toBe('excursion')
    expect(p.location).toBeNull()
    expect(p.issues.map((i) => i.code)).toEqual(['no-location'])
  })

  it('reports (never invents) a missing code and an unrecognised room', () => {
    expect(parseCardLines(['main', 'AIR1', 'NOP / ALC1']).issues.map((i) => i.code)).toContain('no-course-code')
    const odd = parseCardLines(['W26M-AINBA', 'main', 'AIR1', 'Somewhere else'])
    expect(odd.location?.kind).toBe('unknown')
    expect(odd.issues.map((i) => i.code)).toContain('unrecognised-location')
  })

  it('an empty card is an error, not an empty success', () => {
    expect(parseCardLines([]).issues.map((i) => i.code)).toContain('no-course-code')
  })
})

describe('parseTypeText (real type lines)', () => {
  it.each([
    ['main', 'main', [], null],
    ['tutorial', 'tutorial', [], null],
    ['main group A', 'main', ['A'], null],
    ['tutorial group B', 'tutorial', ['B'], null],
    ['main group B,C', 'main', ['B', 'C'], null],
    ['main a', 'main', [], 'a'],
    ['main 2', 'main', [], '2'],
    ['project group work', 'project', [], null],
    ['excursion', 'excursion', [], null],
  ])('%s', (text, kind, groups, variant) => {
    const t = parseTypeText(text, 'W26M-XXXXX')
    expect(t.kind).toBe(kind)
    expect(t.groups).toEqual(groups)
    expect(t.variant).toBe(variant)
    expect(t.issues).toEqual([])
  })

  it('German cards are "language" sessions even without a type line', () => {
    expect(parseTypeText('', 'W26M-Deutsch A2').kind).toBe('language')
    expect(parseTypeText('group B', 'W26M-Deutsch A1.1')).toMatchObject({ kind: 'language', groups: ['B'] })
  })

  it('keeps and flags text it does not understand', () => {
    const t = parseTypeText('Student Conference', 'W26M-LiT')
    expect(t.kind).toBe('other')
    expect(t.issues.map((i) => i.code)).toEqual(['unparsed-type-text', 'unknown-type'])
  })
})

describe('parseLocation', () => {
  it('splits campus and room, recognises online, keeps anything else raw', () => {
    expect(parseLocation('UL / S31')).toMatchObject({ kind: 'room', campus: 'UL', room: 'S31' })
    expect(parseLocation('UL / Meeting 01')).toMatchObject({ kind: 'room', room: 'Meeting 01' })
    expect(parseLocation('NOP / PC-Pool')).toMatchObject({ kind: 'room', room: 'PC-Pool' })
    expect(parseLocation('Online')).toEqual({ kind: 'online', raw: 'Online' })
    expect(parseLocation('Aula')).toEqual({ kind: 'unknown', raw: 'Aula' })
  })
})
