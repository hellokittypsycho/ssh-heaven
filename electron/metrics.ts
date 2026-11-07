import type { ServerMetrics } from '../shared/types'
import { SshService } from './ssh-service'

// Read-only Linux sampling. No shell/profile files are sourced, and no remote
// files are written. Markers allow normal login banners to be ignored safely.
const METRICS_SCRIPT = `LC_ALL=C; export LC_ALL
if [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ] || [ ! -r /proc/uptime ]; then printf 'SSH_HEAVEN_METRICS_UNSUPPORTED\\n'; exit 64; fi
printf 'SSH_HEAVEN_METRICS_V1\\n'
awk '/^PRETTY_NAME=/{sub(/^PRETTY_NAME=/, ""); gsub(/^"|"$/, ""); print "os " $0; found=1; exit} END {if(!found) print "os Linux"}' /etc/os-release 2>/dev/null
awk '{print "uptime " $1; exit}' /proc/uptime
awk '/^cpu /{printf "cpu1"; for(i=2;i<=9;i++) printf " %s",$i; printf "\\n"; exit}' /proc/stat
sleep 0.2
awk '/^cpu /{printf "cpu2"; for(i=2;i<=9;i++) printf " %s",$i; printf "\\n"; exit}' /proc/stat
awk '/^MemTotal:/{total=$2}/^MemAvailable:/{available=$2; have=1}/^MemFree:/{free=$2}/^Buffers:/{buffers=$2}/^Cached:/{cache=$2} END {if(!have) available=free+buffers+cache; printf "memory %s %s\\n",total,available}' /proc/meminfo
df -Pk / 2>/dev/null | awk 'NR==2 {printf "disk %s %s\\n",$2,$3}'`
// Explicit sh keeps sampling independent of a user's interactive login shell
// (for example fish). The script is constant and all inner quotes are escaped.
export const METRICS_COMMAND = `sh -c '${METRICS_SCRIPT.replace(/'/g, "'\\''")}'`

function number(value: string | undefined, label: string): number {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`The server returned invalid ${label} metrics.`)
  const result = Number(value)
  if (!Number.isFinite(result) || result < 0 || result > Number.MAX_SAFE_INTEGER) throw new Error(`The server returned invalid ${label} metrics.`)
  return result
}

function kilobytes(value: string | undefined, label: string): number {
  const bytes = number(value, label) * 1024
  if (!Number.isSafeInteger(bytes)) throw new Error(`The server returned invalid ${label} metrics.`)
  return bytes
}

export function parseServerMetrics(output: string, sessionId: string, host: string): ServerMetrics {
  const marker = output.indexOf('SSH_HEAVEN_METRICS_V1\n')
  if (marker === -1) throw new Error('Server metrics require Linux with readable /proc files and awk/df utilities.')
  const lines = new Map(output.slice(marker + 'SSH_HEAVEN_METRICS_V1\n'.length).split(/\r?\n/).map((line) => {
    const split = line.indexOf(' ')
    return [split === -1 ? line : line.slice(0, split), split === -1 ? '' : line.slice(split + 1)]
  }))
  const memory = (lines.get('memory') ?? '').trim().split(/\s+/)
  const disk = (lines.get('disk') ?? '').trim().split(/\s+/)
  const memoryTotalBytes = kilobytes(memory[0], 'memory')
  const available = kilobytes(memory[1], 'memory')
  const diskTotalBytes = kilobytes(disk[0], 'disk')
  const diskUsedBytes = Math.min(diskTotalBytes, kilobytes(disk[1], 'disk'))
  if (!memoryTotalBytes || !diskTotalBytes) throw new Error('The server did not provide usable memory and disk metrics.')
  let cpuPercent: number | null = null
  const first = lines.get('cpu1')?.trim().split(/\s+/)
  const second = lines.get('cpu2')?.trim().split(/\s+/)
  if (first?.length === 8 && second?.length === 8) {
    const before = first.map((value) => number(value, 'CPU'))
    const after = second.map((value) => number(value, 'CPU'))
    const total = after.reduce((sum, value, index) => sum + value - before[index], 0)
    const idle = after[3] + after[4] - before[3] - before[4]
    if (total > 0 && idle >= 0) cpuPercent = Math.round(Math.max(0, Math.min(100, (1 - idle / total) * 100)) * 10) / 10
  }
  return {
    sessionId, host, os: (lines.get('os')?.trim() || 'Linux').slice(0, 256), uptimeSeconds: number(lines.get('uptime')?.trim(), 'uptime'),
    cpuPercent, memoryTotalBytes, memoryUsedBytes: memoryTotalBytes - Math.min(memoryTotalBytes, available),
    diskTotalBytes, diskUsedBytes, sampledAt: Date.now()
  }
}

export class MetricsService {
  private readonly pending = new Map<string, Promise<ServerMetrics>>()
  constructor(private readonly ssh: SshService) {}

  getServerMetrics(ownerId: number, sessionId: string): Promise<ServerMetrics> {
    const profile = this.ssh.getProfile(ownerId, sessionId)
    const key = `${ownerId}:${sessionId}`
    const previous = this.pending.get(key)
    if (previous) return previous
    const request = this.ssh.execOnSession(ownerId, sessionId, METRICS_COMMAND, { timeoutMs: 8_000, maxBytes: 32 * 1024 }).then((result) => {
      if (result.exitCode !== 0) throw new Error('Server metrics require Linux with readable /proc files and awk/df utilities.')
      return parseServerMetrics(result.stdout, sessionId, profile.host)
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, request)
    return request
  }
}
