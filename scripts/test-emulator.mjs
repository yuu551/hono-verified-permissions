import { spawnSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { devNull, homedir } from 'node:os'
import { join } from 'node:path'

const port = process.env.AWS_EMULATOR_PORT ?? '9297'
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error('AWS_EMULATOR_PORT must be a port between 1 and 65535')
}
const directory = join(homedir(), '.aws', 'emulator', port)
const credentials = join(directory, 'emulator_credentials')
const certificate = join(directory, 'ca.pem')
try {
  await Promise.all([access(credentials), access(certificate)])
} catch {
  throw new Error(`Start AWS Emulator on port ${port}. Its credentials and CA are required in ${directory}.`)
}

// Node reads NODE_EXTRA_CA_CERTS at startup. Give the child only the emulator's AWS settings.
const child = spawnSync(process.execPath, ['--test', 'integration/emulator.ts'], {
  stdio: 'inherit',
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    AWS_ENDPOINT_URL: `https://127.0.0.1:${port}`,
    AWS_SHARED_CREDENTIALS_FILE: credentials,
    AWS_CONFIG_FILE: devNull,
    AWS_PROFILE: 'default',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_REGION: 'us-west-2',
    AWS_MAX_ATTEMPTS: '1',
    NODE_EXTRA_CA_CERTS: certificate,
  },
})
if (child.error) throw child.error
process.exitCode = child.status ?? 1
