import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AgentConfig,
  AppConfig,
  Attachment,
  BackgroundTask,
  AppEvent,
  Board,
  ApprovalRequest,
  Block,
  FileEntry,
  Message,
  RepoChanges,
  Session,
  Skill
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
  agents: {
    list: (): Promise<Record<string, AgentConfig>> => ipcRenderer.invoke('agents:list'),
    dir: (): Promise<string> => ipcRenderer.invoke('agents:dir'),
    save: (agent: AgentConfig): Promise<AgentConfig> => ipcRenderer.invoke('agents:save', agent),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('agents:delete', id),
    reveal: (id: string): Promise<void> => ipcRenderer.invoke('agents:reveal', id),
    importable: (): Promise<{ id: string; name: string; description: string }[]> =>
      ipcRenderer.invoke('agents:importable'),
    importFrom: (ids: string[]): Promise<number> => ipcRenderer.invoke('agents:import', ids)
  },
  skills: {
    list: (): Promise<Skill[]> => ipcRenderer.invoke('skills:list'),
    dir: (): Promise<string> => ipcRenderer.invoke('skills:dir'),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('skills:delete', id),
    reveal: (): Promise<void> => ipcRenderer.invoke('skills:reveal'),
    importable: (): Promise<(Skill & { alreadyHere: boolean })[]> =>
      ipcRenderer.invoke('skills:importable'),
    importFrom: (ids: string[]): Promise<number> => ipcRenderer.invoke('skills:import', ids)
  },
  secrets: {
    status: (): Promise<{
      available: boolean
      path: string
      failed: string[]
      hints: Record<string, string | null>
    }> =>
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
    home: (id: string): Promise<string> => ipcRenderer.invoke('env:home', id),
    sshAliases: (): Promise<
      { alias: string; host?: string; username?: string; port?: number; identityFile?: string }[]
    > => ipcRenderer.invoke('env:sshAliases')
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
    fork: (
      id: string,
      target?: { boardId?: string; columnId?: string }
    ): Promise<Session | undefined> => ipcRenderer.invoke('session:fork', id, target),
    messages: (id: string): Promise<Message[]> => ipcRenderer.invoke('session:messages', id),
    blocks: (id: string): Promise<Block[]> => ipcRenderer.invoke('session:blocks', id),
    running: (id: string): Promise<boolean> => ipcRenderer.invoke('session:running', id)
  },
  shell: {
    run: (
      sessionId: string,
      command: string
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
      ipcRenderer.invoke('shell:run', sessionId, command)
  },
  boards: {
    list: (): Promise<Board[]> => ipcRenderer.invoke('board:list'),
    create: (input: { name?: string; cwd?: string; environmentId?: string }): Promise<Board> =>
      ipcRenderer.invoke('board:create', input),
    update: (id: string, patch: Partial<Board>): Promise<Board | undefined> =>
      ipcRenderer.invoke('board:update', id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('board:delete', id),
    createTask: (input: {
      boardId?: string
      columnId?: string
      title?: string
      prompt?: string
      agentId?: string
      model?: string
      parentSessionId?: string
    }): Promise<Session | undefined> => ipcRenderer.invoke('board:createTask', input),
    moveTask: (input: {
      sessionId: string
      boardId: string
      columnId: string
      order?: number
    }): Promise<Session | undefined> => ipcRenderer.invoke('board:moveTask', input),
    addSession: (input: {
      sessionId: string
      boardId: string
      columnId?: string
    }): Promise<Session | undefined> => ipcRenderer.invoke('board:addSession', input),
    removeSession: (sessionId: string): Promise<Session | undefined> =>
      ipcRenderer.invoke('board:removeSession', sessionId)
  },
  attachments: {
    pick: (sessionId: string): Promise<{ added: Attachment[]; errors: string[] }> =>
      ipcRenderer.invoke('attachments:pick', sessionId),
    addPaths: (
      sessionId: string,
      paths: string[]
    ): Promise<{ added: Attachment[]; errors: string[] }> =>
      ipcRenderer.invoke('attachments:addPaths', sessionId, paths),
    addBytes: (
      sessionId: string,
      name: string,
      mediaType: string,
      bytes: Uint8Array
    ): Promise<{ added: Attachment[]; errors: string[] }> =>
      ipcRenderer.invoke('attachments:addBytes', sessionId, name, mediaType, bytes),
    remove: (path: string): Promise<void> => ipcRenderer.invoke('attachments:remove', path),
    accepted: (model: string): Promise<{ images: boolean }> =>
      ipcRenderer.invoke('attachments:accepted', model),
    /** Electron no longer exposes File.path; this is the supported way. */
    pathFor: (file: File): string => webUtils.getPathForFile(file)
  },
  turn: {
    send: (sessionId: string, text: string, attachments?: Attachment[]): Promise<boolean> =>
      ipcRenderer.invoke('turn:send', sessionId, text, attachments),
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
      ipcRenderer.invoke('preview:url', environmentId, path),
    stat: (
      environmentId: string,
      path: string
    ): Promise<{ size: number; modifiedAt: number } | null> =>
      ipcRenderer.invoke('fs:stat', environmentId, path),
    download: (
      environmentId: string,
      path: string
    ): Promise<{ saved: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('fs:download', environmentId, path)
  },
  terminal: {
    create: (input: {
      environmentId: string
      cwd: string
      cols: number
      rows: number
    }): Promise<{ id: string; buffer: string }> => ipcRenderer.invoke('terminal:create', input),
    write: (id: string, data: string): Promise<void> => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id: string): Promise<void> => ipcRenderer.invoke('terminal:kill', id),
    buffer: (id: string): Promise<string> => ipcRenderer.invoke('terminal:buffer', id)
  },
  background: {
    list: (sessionId?: string): Promise<BackgroundTask[]> =>
      ipcRenderer.invoke('background:list', sessionId),
    kill: (id: string): Promise<BackgroundTask | null> => ipcRenderer.invoke('background:kill', id),
    clear: (sessionId?: string): Promise<number> => ipcRenderer.invoke('background:clear', sessionId),
    peek: (id: string): Promise<{ task: BackgroundTask; chunk: string } | null> =>
      ipcRenderer.invoke('background:peek', id)
  },
  git: {
    changes: (environmentId: string, cwd: string): Promise<RepoChanges> =>
      ipcRenderer.invoke('git:changes', environmentId, cwd),
    summary: (
      environmentId: string,
      cwd: string
    ): Promise<{ isRepo: boolean; branch: string; dirty: number }> =>
      ipcRenderer.invoke('git:summary', environmentId, cwd),
    diff: (environmentId: string, cwd: string, path: string, untracked: boolean): Promise<string> =>
      ipcRenderer.invoke('git:diff', environmentId, cwd, path, untracked)
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
