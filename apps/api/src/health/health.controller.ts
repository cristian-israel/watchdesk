import { Controller, Get, Res } from '@nestjs/common'
import type { Response } from 'express'
import { DatabaseService } from '../database/database.service'

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async health(@Res() res: Response) {
    try {
      const ok = await this.db.healthCheck()
      return res.status(ok ? 200 : 503).json({ ok })
    } catch {
      return res.status(503).json({ ok: false })
    }
  }
}
