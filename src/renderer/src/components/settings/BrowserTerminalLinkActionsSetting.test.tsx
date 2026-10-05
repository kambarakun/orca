// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { BrowserTerminalLinkActionsSetting } from './BrowserTerminalLinkActionsSetting'

type LinkSettings = Pick<
  GlobalSettings,
  | 'terminalLinkActionPopoverEnabled'
  | 'terminalLinkClickBehavior'
  | 'terminalUrlMiddleClickBehavior'
>

function Settings({ initial }: { initial: LinkSettings }): React.JSX.Element {
  const [settings, setSettings] = useState(initial)
  return (
    <BrowserTerminalLinkActionsSetting
      settings={settings}
      isMac={false}
      updateSettings={(updates) => setSettings((current) => ({ ...current, ...updates }))}
    />
  )
}

function option(group: string, label: string): HTMLElement {
  return within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name: label })
}

afterEach(cleanup)

describe('terminal URL click settings', () => {
  it.each([undefined, 'actions'] as const)(
    'keeps Actions selected after re-enabling a legacy profile with behavior %s',
    (behavior) => {
      const initial: LinkSettings = {
        terminalLinkActionPopoverEnabled: false,
        terminalLinkClickBehavior: behavior,
        terminalUrlMiddleClickBehavior: 'none'
      }
      const { rerender } = render(<Settings initial={initial} />)
      expect(
        option('Plain click URL behavior', 'Leave to terminal').getAttribute('aria-checked')
      ).toBe('true')

      fireEvent.click(option('Plain click URL behavior', 'Actions'))
      expect(option('Plain click URL behavior', 'Actions').getAttribute('aria-checked')).toBe(
        'true'
      )
      rerender(<Settings initial={initial} />)
      expect(option('Plain click URL behavior', 'Actions').getAttribute('aria-checked')).toBe(
        'true'
      )
      expect(option('Middle click', 'Leave to terminal').getAttribute('aria-checked')).toBe('true')

      for (const label of ['Open URL', 'Leave to terminal', 'Actions']) {
        fireEvent.click(option('Plain click URL behavior', label))
        expect(option('Plain click URL behavior', label).getAttribute('aria-checked')).toBe('true')
      }
    }
  )

  it('keeps middle-click choices independent of the legacy plain-click opt-out', () => {
    render(
      <Settings
        initial={{ terminalLinkActionPopoverEnabled: false, terminalLinkClickBehavior: 'actions' }}
      />
    )
    for (const label of ['Actions', 'Leave to terminal', 'Open URL']) {
      fireEvent.click(option('Middle click', label))
      expect(option('Middle click', label).getAttribute('aria-checked')).toBe('true')
      expect(
        option('Plain click URL behavior', 'Leave to terminal').getAttribute('aria-checked')
      ).toBe('true')
    }
  })
})
