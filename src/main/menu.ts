/**
 * The application menu, which exists for one reason: ⌘R.
 *
 * Electron installs a default menu when none is set, and that menu binds ⌘R to
 * Reload. A menu accelerator is handled before the page sees the key, so the
 * shortcut for finding a folder would have thrown the window away instead —
 * and a renderer that reloads mid-turn looks exactly like a crash.
 *
 * So the default is rebuilt with the standard roles, which is also what keeps
 * copy, paste, undo and the window controls working on macOS, and reload moves
 * to ⇧⌘R where a reload belongs.
 */
import { Menu, app, type MenuItemConstructorOptions } from 'electron'

export function installMenu(): void {
  const mac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // ⌘R belongs to the folder search; a reload is the rarer thing and
        // takes the modifier.
        { role: 'reload', accelerator: 'Shift+CmdOrCtrl+R' },
        { role: 'forceReload', accelerator: 'Shift+CmdOrCtrl+Alt+R' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  // Nothing else reads this; it is here so the intent survives a refactor of
  // the template above.
  app.setAboutPanelOptions?.({ applicationName: 'OpenDesktop' })
}
