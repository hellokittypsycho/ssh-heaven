import { Cloud, Code, Database, Globe, Server, Shield } from 'lucide-react'
import type { HostProfile } from '../../shared/types'
export function HostIcon({ profile, size = 16 }: { profile: Pick<HostProfile, 'color' | 'icon'>; size?: number }) {
  const Icon = ({ server: Server, database: Database, cloud: Cloud, code: Code, shield: Shield, globe: Globe })[profile.icon || 'server'] || Server
  return <Icon size={size} style={profile.color ? { color: profile.color } : undefined} aria-hidden="true" />
}
