/// <reference types="vite/client" />
import type { SshHeavenApi } from '../shared/types'
declare global { interface Window { sshHeaven: SshHeavenApi } }
