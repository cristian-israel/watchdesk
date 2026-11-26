import { Injectable } from '@nestjs/common'

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      return argv[i + 1]
    }
  }
  return undefined
}

@Injectable()
export class AppEnv {
  readonly port = Number(argValue('port') || process.env.PORT || 7030)
  readonly publicHost = argValue('public-host') || process.env.PUBLIC_HOST || ''
  readonly turnSecret = argValue('turn-secret') || process.env.TURN_SECRET || ''
  readonly turnHost = argValue('turn-host') || process.env.TURN_HOST || ''
  readonly turnPort = Number(argValue('turn-port') || process.env.TURN_PORT || 3478)
  readonly turnRealm = argValue('turn-realm') || process.env.TURN_REALM || 'watchdesk'
  readonly databaseUrl = process.env.DATABASE_URL || ''
  readonly adminLogin = process.env.ADMIN_LOGIN || 'admin'
  readonly adminPassword = process.env.ADMIN_PASSWORD || 'admin123'
  readonly adminDisplayName = process.env.ADMIN_DISPLAY_NAME || 'Admin'
}
