import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/e2e/fixtures/terminal-link-mouse-owner-fixture.cjs'
)
const LINK = 'https://example.com/sta-3888'
const OSC_LINK_TEXT = 'STA_3888_OSC_LINK'

type LinkTarget = { x: number; y: number; mouseTrackingMode: string }
type LinkMode = 'http' | 'osc'

async function startMouseAwareLinkFixture(
  orcaPage: Page,
  testInfo: TestInfo,
  linkMode: LinkMode = 'http'
): Promise<{ mouseLogPath: string; ptyId: string; target: LinkTarget }> {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await waitForPaneCount(orcaPage, 1)

  const ptyId = await waitForActivePanePtyId(orcaPage)
  const mouseLogPath = testInfo.outputPath('child-mouse-reports.log')
  await execInTerminal(
    orcaPage,
    ptyId,
    `node ${JSON.stringify(FIXTURE_PATH)} ${JSON.stringify(mouseLogPath)} ${linkMode}`
  )
  const renderedLinkText = linkMode === 'osc' ? OSC_LINK_TEXT : LINK
  await waitForTerminalOutput(orcaPage, 'LINK_MOUSE_READY')

  const target = await orcaPage.evaluate((linkText) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId = worktreeId ? state?.activeTabIdByWorktree?.[worktreeId] : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen') ?? null
    if (!pane || !screen) {
      throw new Error('Active terminal screen unavailable')
    }

    const buffer = pane.terminal.buffer.active
    for (let viewportRow = 0; viewportRow < pane.terminal.rows; viewportRow += 1) {
      const text = buffer.getLine(buffer.viewportY + viewportRow)?.translateToString(false)
      const column = text?.indexOf(linkText) ?? -1
      if (column < 0) {
        continue
      }
      const rect = screen.getBoundingClientRect()
      const cell = pane.terminal.dimensions?.css.cell
      if (!cell?.width || !cell.height) {
        throw new Error('Active terminal cell dimensions unavailable')
      }
      return {
        x: rect.left + (column + linkText.length / 2) * cell.width,
        y: rect.top + (viewportRow + 0.5) * cell.height,
        mouseTrackingMode: pane.terminal.modes.mouseTrackingMode
      }
    }
    throw new Error('Rendered fixture link unavailable')
  }, renderedLinkText)

  expect(target.mouseTrackingMode).not.toBe('none')
  return { mouseLogPath, ptyId, target }
}

function childMouseReportCount(mouseLogPath: string): number {
  if (!existsSync(mouseLogPath)) {
    return 0
  }
  return readFileSync(mouseLogPath, 'utf8').trim().split(/\s+/).filter(Boolean).length
}

async function expectChildMouseReports(mouseLogPath: string): Promise<void> {
  await expect
    .poll(() => childMouseReportCount(mouseLogPath), { timeout: 5_000 })
    .toBeGreaterThan(0)
}

async function expectOrcaOwnedMouseOutcome(mouseLogPath: string): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
  expect(childMouseReportCount(mouseLogPath)).toBe(0)
}

test.describe('terminal link click ownership', () => {
  test('an Orca-owned plain link click emits no child PTY mouse frames', async ({
    orcaPage
  }, testInfo) => {
    const { mouseLogPath, ptyId, target } = await startMouseAwareLinkFixture(orcaPage, testInfo)
    await orcaPage.mouse.click(target.x, target.y)

    await expect(orcaPage.locator('[data-terminal-link-action-popover]')).toBeVisible()
    await expect(orcaPage.locator('[data-terminal-link-destination]')).toHaveText(LINK)

    await expectOrcaOwnedMouseOutcome(mouseLogPath)

    await sendToTerminal(orcaPage, ptyId, 'q')
  })

  test('an Orca-owned OSC link click emits no child PTY mouse frames', async ({
    orcaPage
  }, testInfo) => {
    const { mouseLogPath, ptyId, target } = await startMouseAwareLinkFixture(
      orcaPage,
      testInfo,
      'osc'
    )
    await orcaPage.mouse.move(target.x, target.y)
    await expect(orcaPage.locator('.xterm-hover')).toHaveCount(1)
    await orcaPage.mouse.click(target.x, target.y)

    await expect(orcaPage.locator('[data-terminal-link-action-popover]')).toBeVisible()
    await expect(orcaPage.locator('[data-terminal-link-destination]')).toHaveText(LINK)
    await expectOrcaOwnedMouseOutcome(mouseLogPath)

    await sendToTerminal(orcaPage, ptyId, 'q')
  })

  test('a plain click stays child-owned when link actions are disabled', async ({
    orcaPage
  }, testInfo) => {
    const { mouseLogPath, ptyId, target } = await startMouseAwareLinkFixture(orcaPage, testInfo)
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ terminalLinkActionPopoverEnabled: false })
    })

    await orcaPage.mouse.click(target.x, target.y)

    await expect(orcaPage.locator('[data-terminal-link-action-popover]')).toHaveCount(0)
    await expectChildMouseReports(mouseLogPath)
    await sendToTerminal(orcaPage, ptyId, 'q')
  })

  test('a drag across a link stays child-owned', async ({ orcaPage }, testInfo) => {
    const { mouseLogPath, ptyId, target } = await startMouseAwareLinkFixture(orcaPage, testInfo)

    await orcaPage.mouse.move(target.x, target.y)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(target.x + 12, target.y + 12, { steps: 3 })
    await orcaPage.mouse.up()

    await expect(orcaPage.locator('[data-terminal-link-action-popover]')).toHaveCount(0)
    await expectChildMouseReports(mouseLogPath)
    await sendToTerminal(orcaPage, ptyId, 'q')
  })
})

async function openLinkSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.openSettingsTarget({
      pane: 'browser',
      repoId: null,
      sectionId: 'browser-terminal-link-actions'
    })
    state?.openSettingsPage()
  })
  await expect(page.getByRole('radiogroup', { name: 'Plain click URL behavior' })).toBeVisible()
}

function seedLegacyLinkSettings(userDataDir: string): void {
  const profile = getE2ECompletedOnboardingProfile()
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    JSON.stringify({
      ...profile,
      settings: {
        ...profile.settings,
        uiLanguage: 'en',
        terminalLinkActionPopoverEnabled: false,
        terminalUrlMiddleClickBehavior: 'none'
      }
    })
  )
}

test('re-enables legacy link actions through settings and keeps them after restart', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const session = createRestartSession(testInfo)
  seedLegacyLinkSettings(session.userDataDir)
  let current: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    current = await session.launch()
    await waitForSessionReady(current.page)
    await attachRepoAndOpenTerminal(current.page, testRepoPath)
    const legacy = await startMouseAwareLinkFixture(current.page, testInfo)
    await current.page.mouse.click(legacy.target.x, legacy.target.y)
    await expect(current.page.locator('[data-terminal-link-action-popover]')).toHaveCount(0)
    await expectChildMouseReports(legacy.mouseLogPath)
    await sendToTerminal(current.page, legacy.ptyId, 'q')
    await openLinkSettings(current.page)
    await expect(
      current.page
        .getByRole('radiogroup', { name: 'Plain click URL behavior' })
        .getByRole('radio', { name: 'Leave to terminal' })
    ).toHaveAttribute('aria-checked', 'true')
    await session.close(current.app)
    current = null

    current = await session.launch()
    await waitForSessionReady(current.page)
    await openLinkSettings(current.page)
    const plain = current.page.getByRole('radiogroup', { name: 'Plain click URL behavior' })
    await expect(plain.getByRole('radio', { name: 'Leave to terminal' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await plain.getByRole('radio', { name: 'Actions', exact: true }).click()
    try {
      await expect(plain.getByRole('radio', { name: 'Actions', exact: true })).toHaveAttribute(
        'aria-checked',
        'true'
      )
    } finally {
      await testInfo.attach('actions-selection', {
        body: await current.page.locator('#browser-terminal-link-actions').screenshot({
          path: testInfo.outputPath('actions-selection.png')
        }),
        contentType: 'image/png'
      })
    }
    await expect(
      current.page
        .getByRole('radiogroup', { name: 'Middle click', exact: true })
        .getByRole('radio', { name: 'Leave to terminal' })
    ).toHaveAttribute('aria-checked', 'true')
    await current.page.evaluate(() => window.__store?.getState().closeSettingsPage())
    const enabled = await startMouseAwareLinkFixture(current.page, testInfo)
    await current.page.mouse.click(enabled.target.x, enabled.target.y)
    await expect(current.page.locator('[data-terminal-link-destination]')).toHaveText(LINK)
    await testInfo.attach('actions-popover', {
      body: await current.page.locator('[data-terminal-link-action-popover]').screenshot({
        path: testInfo.outputPath('actions-popover.png')
      }),
      contentType: 'image/png'
    })
    await sendToTerminal(current.page, enabled.ptyId, 'q')
    await session.close(current.app)
    current = null

    current = await session.launch()
    await waitForSessionReady(current.page)
    await openLinkSettings(current.page)
    await expect(
      current.page
        .getByRole('radiogroup', { name: 'Plain click URL behavior' })
        .getByRole('radio', { name: 'Actions', exact: true })
    ).toHaveAttribute('aria-checked', 'true')
    await testInfo.attach('actions-after-restart', {
      body: await current.page.locator('#browser-terminal-link-actions').screenshot({
        path: testInfo.outputPath('actions-after-restart.png')
      }),
      contentType: 'image/png'
    })
    await current.page.evaluate(() => window.__store?.getState().closeSettingsPage())
    const restored = await startMouseAwareLinkFixture(current.page, testInfo)
    await current.page.mouse.click(restored.target.x, restored.target.y)
    await expect(current.page.locator('[data-terminal-link-destination]')).toHaveText(LINK)
    await sendToTerminal(current.page, restored.ptyId, 'q')
  } finally {
    if (current) {
      await session.close(current.app)
    }
    await session.dispose()
  }
})

for (const label of ['Open URL', 'Leave to terminal']) {
  test(`keeps ${label} selected after restarting a legacy profile`, async ({
    testRepoPath
  }, testInfo) => {
    const session = createRestartSession(testInfo)
    seedLegacyLinkSettings(session.userDataDir)
    let current: Awaited<ReturnType<typeof session.launch>> | null = null
    try {
      current = await session.launch()
      await waitForSessionReady(current.page)
      await attachRepoAndOpenTerminal(current.page, testRepoPath)
      await openLinkSettings(current.page)
      const plain = current.page.getByRole('radiogroup', { name: 'Plain click URL behavior' })
      await plain.getByRole('radio', { name: 'Open URL' }).click()
      await expect(plain.getByRole('radio', { name: 'Open URL' })).toHaveAttribute(
        'aria-checked',
        'true'
      )
      await plain.getByRole('radio', { name: label }).click()
      await expect(plain.getByRole('radio', { name: label })).toHaveAttribute(
        'aria-checked',
        'true'
      )
      await session.close(current.app)
      current = null
      current = await session.launch()
      await waitForSessionReady(current.page)
      await openLinkSettings(current.page)
      await expect(
        current.page
          .getByRole('radiogroup', { name: 'Plain click URL behavior' })
          .getByRole('radio', { name: label })
      ).toHaveAttribute('aria-checked', 'true')
    } finally {
      if (current) {
        await session.close(current.app)
      }
      await session.dispose()
    }
  })
}
