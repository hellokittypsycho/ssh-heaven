import { randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'
import type { GroupCommandEvent, GroupCommandRequest, HostProfile } from '../shared/types'
import { CredentialVault, credentialBinding } from './credentials'
import { SshService } from './ssh-service'
import { AppStore } from './store'
import { errorMessage, identifier, integer, record, textValue } from './validation'

export const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024
interface CommandTask {
  run: CommandRun
  profile: HostProfile
  event: GroupCommandEvent
  controller: AbortController
  lastEmission: number
  outputBytes: number
  timedOut: boolean
}
interface CommandRun {
  ownerId: number
  request: GroupCommandRequest
  tasks: CommandTask[]
  remaining: number
  done: Promise<void>
  finish(): void
}

export class GroupCommandManager {
  private readonly runs = new Map<string, CommandRun>()
  private readonly queue: CommandTask[] = []
  private active = 0

  constructor(private readonly store: AppStore, private readonly vault: CredentialVault, private readonly ssh: SshService, private readonly notify: (ownerId: number, event: GroupCommandEvent) => void) {}

  start(ownerId: number, value: unknown): void {
    const input = record(value, 'group command request')
    const runId = identifier(input.runId, 'command run identifier')
    const group = textValue(input.group, 'host group', 100)
    if (!group.trim()) throw new Error('Choose a named host group.')
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 32768 || input.command.includes('\0')) throw new Error('Enter a command of at most 32768 characters.')
    if (!Array.isArray(input.profileIds) || input.profileIds.length === 0 || input.profileIds.length > 1000) throw new Error('Review and select between 1 and 1000 saved hosts.')
    const profileIds = input.profileIds.map((id) => identifier(id, 'target host identifier'))
    if (new Set(profileIds).size !== profileIds.length) throw new Error('The reviewed host list contains duplicates. Review the targets again.')
    if (input.passphrase !== undefined && (typeof input.passphrase !== 'string' || input.passphrase.length > 8192)) throw new Error('Invalid SSH key passphrase.')
    const timeoutSeconds = input.timeoutSeconds === undefined ? 300 : integer(input.timeoutSeconds, 'command timeout', 1, 3600)
    if (this.runs.has(runId)) throw new Error('This command run identifier has already been used.')
    if ([...this.runs.values()].some((run) => run.remaining > 0)) throw new Error('Wait for the active group command to finish, or cancel it before starting another.')
    const profiles = new Map(this.store.listProfiles().map((profile) => [profile.id, profile]))
    const targets = profileIds.map((id) => {
      const profile = profiles.get(id)
      if (!profile || profile.group !== group) throw new Error('The reviewed host group changed. Review the targets again before running the command.')
      return profile
    })
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const run: CommandRun = { ownerId, request: { runId, group, profileIds, command: input.command, passphrase: input.passphrase as string | undefined, timeoutSeconds }, tasks: [], remaining: targets.length, done, finish }
    this.runs.set(runId, run)
    for (const profile of targets) {
      const task: CommandTask = { run, profile, controller: new AbortController(), lastEmission: 0, outputBytes: 0, timedOut: false, event: { runId, profileId: profile.id, host: profile.host, username: profile.username, name: profile.name, status: 'queued', output: '' } }
      run.tasks.push(task); this.queue.push(task); this.emit(task)
    }
    // Starting is deliberately asynchronous so the IPC call returns once the
    // reviewed targets have been queued, rather than waiting for remote work.
    queueMicrotask(() => this.pump())
    this.prune()
  }

  cancel(ownerId: number, value: unknown): void {
    const runId = identifier(value, 'command run identifier')
    const run = this.runs.get(runId)
    if (!run || run.ownerId !== ownerId) throw new Error('This command run is unavailable or belongs to another window.')
    for (const task of run.tasks) {
      if (task.event.finishedAt) continue
      task.controller.abort()
      if (task.event.status === 'queued') this.complete(task, 'canceled', 'Canceled before connecting.')
    }
  }

  async cancelOwner(ownerId: number): Promise<void> {
    const active = [...this.runs.values()].filter((run) => run.ownerId === ownerId && run.remaining > 0)
    for (const run of active) this.cancel(ownerId, run.request.runId)
    await Promise.all(active.map((run) => run.done))
  }

  async dispose(): Promise<void> {
    const active = [...this.runs.values()].filter((run) => run.remaining > 0)
    for (const run of active) this.cancel(run.ownerId, run.request.runId)
    await Promise.all(active.map((run) => run.done))
  }

  private pump(): void {
    while (this.active < 4 && this.queue.length) {
      const task = this.queue.shift()!
      if (task.event.finishedAt) continue
      this.active++
      void this.execute(task).finally(() => { this.active--; this.pump() })
    }
  }

  private async execute(task: CommandTask): Promise<void> {
    task.event.startedAt = Date.now()
    const timeout = setTimeout(() => { task.timedOut = true; task.controller.abort() }, task.run.request.timeoutSeconds! * 1000)
    const stdout = new TextDecoder()
    const stderr = new TextDecoder()
    try {
      task.controller.signal.throwIfAborted()
      const latest = this.store.listProfiles().find((profile) => profile.id === task.profile.id)
      if (!latest || latest.group !== task.run.request.group || credentialBinding(latest) !== credentialBinding(task.profile)) throw new Error('This host changed after the target review. Review the group again.')
      let password: string | undefined
      if (task.profile.authType === 'password') {
        password = await this.vault.get(task.profile)
        if (password === undefined) throw new Error('This host has no saved password. Remember a password or configure an SSH key first.')
      }
      const result = await this.ssh.execute(task.run.ownerId, { sessionId: `group_${randomUUID()}`, profile: task.profile, command: task.run.request.command, password, passphrase: task.run.request.passphrase }, task.controller.signal, {
        phase: (status) => { task.event.status = status; this.emit(task) },
        data: (data, stream) => this.append(task, (stream === 'stdout' ? stdout : stderr).decode(data, { stream: true }))
      })
      this.append(task, stdout.decode() + stderr.decode())
      task.event.exitCode = result.exitCode
      if (result.exitCode !== null && result.exitCode !== 0) this.complete(task, 'failed', `Command exited with status ${result.exitCode}.`)
      else this.complete(task, 'completed')
    } catch (error) {
      this.append(task, stdout.decode() + stderr.decode())
      this.complete(task, task.timedOut ? 'failed' : task.controller.signal.aborted ? 'canceled' : 'failed', task.timedOut ? `Command timed out after ${task.run.request.timeoutSeconds} seconds. The SSH channel was closed.` : errorMessage(error))
    } finally { clearTimeout(timeout) }
  }

  private append(task: CommandTask, text: string): void {
    if (!text) return
    const bytes = Buffer.from(text, 'utf8')
    const remaining = MAX_COMMAND_OUTPUT_BYTES - task.outputBytes
    const previousTruncated = task.event.truncated
    if (bytes.length > remaining) task.event.truncated = true
    if (remaining > 0) {
      // Dropping an incomplete trailing code point keeps the capped snapshot
      // valid UTF-8 and never exceeds the byte limit with replacement glyphs.
      const part = new TextDecoder().decode(bytes.subarray(0, remaining), { stream: true })
      task.event.output = (task.event.output ?? '') + part
      task.outputBytes += Buffer.byteLength(part)
    }
    const now = Date.now()
    if (now - task.lastEmission >= 80 || previousTruncated !== task.event.truncated) { task.lastEmission = now; this.emit(task) }
  }

  private emit(task: CommandTask): void { this.notify(task.run.ownerId, { ...task.event }) }

  private complete(task: CommandTask, status: 'completed' | 'failed' | 'canceled', error?: string): void {
    if (task.event.finishedAt) return
    task.event.status = status; task.event.error = error; task.event.finishedAt = Date.now()
    this.emit(task)
    // The renderer already received the final snapshot. Do not retain up to
    // 256 KiB per finished host while a 1000-host run is draining its queue.
    task.event.output = undefined
    task.run.remaining--
    if (task.run.remaining === 0) { task.run.request.passphrase = undefined; task.run.finish(); this.prune() }
  }

  private prune(): void {
    for (const [id, run] of this.runs) {
      if (this.runs.size <= 5) break
      if (run.remaining === 0) this.runs.delete(id)
    }
  }
}
