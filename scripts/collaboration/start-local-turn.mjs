import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Only loopback networking is enabled by the read-only fixture configuration.
// Host networking is required on Linux so Chromium can reach the relay ports.
const config = fileURLToPath(new URL('./coturn.local.conf', import.meta.url))
const name = `pubky-notes-turn-test-${process.pid}`
const docker = spawn('docker', [
  'run', '--rm', '--name', name, '--network=host',
  '--mount', `type=bind,src=${config},dst=/etc/coturn/turnserver.conf,readonly`,
  'coturn/coturn:4.18.0-r0', '-c', '/etc/coturn/turnserver.conf',
], { stdio: 'inherit' })
docker.on('error', (error) => { console.error(`Could not start local TURN: ${error.message}`); process.exitCode = 1 })
docker.on('exit', (code) => { process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  // Address only this script's uniquely named test container.
  const stop = spawn('docker', ['stop', '--time', '2', name], { stdio: 'ignore' })
  stop.on('error', () => docker.kill(signal))
})
