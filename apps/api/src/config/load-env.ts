import fs from 'node:fs'
import path from 'node:path'
import { config } from 'dotenv'

const candidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
  path.resolve(__dirname, '../../../.env'),
]

const envFile = candidates.find((p) => fs.existsSync(p))
if (envFile) {
  config({ path: envFile })
}
