import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig,
  AppEvent,
  ApprovalRequest,
  Block,
  FileEntry,
  Message,
  Session
} from '@shared/types'

const api = {
  config: {
    get: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
    path: (): Promise<string> => ipcRenderer.invoke('config:path'),
    getText: (): Promise<string> => ipcRenderer.invoke('config:getText'),
    setText: (text: string): Promise<AppConfig> => ipcRenderer.invoke('config:setText', text),
    save: (next: AppConfig): Promise<AppConfig> => ipcRenderer.invoke('config:save', next),
    reveal: (): Promise<void> => ipcRenderer.invoke('config:reveal'),
    keyStatus: (): Promise<Record<string, { resolved: boolean; source: string }>> =>
      ipcRenderer.invoke('host:resolvedConfigCheck')
  },
  secrets: {
    status: (): Promise<{ available: boolean; path: string; hints: Record<string, string | null> }> =>
      ipcRenderer.invoke('secrets:status'),
    set: (name: string, value: string): Promise<string | null> =>
      ipcRenderer.invoke('secrets:set', name, value),
    remove: (name: string): Promise<void> => ipcRenderer.invoke('secrets:delete', name)
  },
  models: {
    list: (): Promise<{ ref: string; label: string; provider: string }[]> =>
      ipcRenderer.invoke('models:list')
  },
  env: {
    test: (id: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('env:test', id),
    home: (id: string): Promise<string> => ipcRenderer.invoke('env:home', id)
  },
  sessions: {
    list: (): Promise<Session[]> => ipcRenderer.invoke('session:list'),
    create: (input: {
      cwd?: string
      environmentId?: string
      agentId?: string
      model?: string
      title?: string
    }): Promise<Session> => ipcRenderer.invoke('session:create', input),
    update: (id: string, patch: Partial<Session>): Promise<Session | undefined> =>
      ipcRenderer.invoke('session:update', id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('session:delete', id),
    clear: (id: string): Promise<Session | undefined> => ipcRenderer.invoke('session:clear', id),
    messages: (id: string): Promise<Message[]> => ipcRenderer.invoke('session:messages', id),
    blocks: (id: string): Promise<Block[]> => ipcRenderer.invoke('session:blocks', id),
    running: (id: string): Promise<boolean> => ipcRenderer.invoke('session:running', id)
  },
  turn: {
    send: (sessionId: string, text: string): Promise<boolean> =>
      ipcRenderer.invoke('turn:send', sessionId, text),
    stop: (sessionId: string): Promise<void> => ipcRenderer.invoke('turn:stop', sessionId)
  },
  approvals: {
    list: (): Promise<ApprovalRequest[]> => ipcRenderer.invoke('approval:list'),
    resolve: (id: string, answer: 'once' | 'always' | 'reject'): Promise<void> =>
      ipcRenderer.invoke('approval:resolve', id, answer)
  },
  activity: {
    all: (limit?: number): Promise<Block[]> => ipcRenderer.invoke('blocks:all', limit),
    folders: (): Promise<string[]> => ipcRenderer.invoke('blocks:folders')
  },
  files: {
    list: (environmentId: string, path: string): Promise<{ path: string; entries: FileEntry[] }> =>
      ipcRenderer.invoke('fs:list', environmentId, path),
    read: (environmentId: string, path: string): Promise<string> =>
      ipcRenderer.invoke('fs:read', environmentId, path),
    previewUrl: (environmentId: string, path: string): Promise<string> =>
      ipcRenderer.invoke('preview:url', environmentId, path)
  },
  host: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('host:pickFolder'),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('host:openExternal', url),
    openPath: (path: string): Promise<string> => ipcRenderer.invoke('host:openPath', path)
  },
  onEvent: (listener: (event: AppEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: AppEvent): void => listener(event)
    ipcRenderer.on('app:event', handler)
    return () => ipcRenderer.off('app:event', handler)
  }
}

export type OpenDesktopApi = typeof api

contextBridge.exposeInMainWorld('opendesktop', api)
