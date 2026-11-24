import { Injectable, NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { clientIp, createRateLimiter } from './http-util'

const limiter = createRateLimiter()

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const ip = clientIp(req) || '?'
    if (limiter.blocked(ip)) {
      res.setHeader('Retry-After', '60')
      res.status(429).type('text/plain').send('Muitas tentativas. Aguarde 1 minuto.')
      return
    }
    next()
  }
}

export { limiter as httpRateLimiter }
