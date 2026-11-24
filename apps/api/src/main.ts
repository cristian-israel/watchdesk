import './config/load-env'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { AppEnv } from './config/app-env'
import { SignalService } from './live/signal.service'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: true })
  app.setGlobalPrefix('api')

  const env = app.get(AppEnv)
  const signal = app.get(SignalService)

  await app.listen(env.port, '0.0.0.0')
  const server = app.getHttpServer()
  signal.attach(server)

  console.log('\n=== Watchdesk API ===')
  console.log(`Porta:  ${env.port}`)
  console.log(`WS:     /api/ws`)
  console.log('DB:     ok')
  if (env.turnSecret && (env.turnHost || env.publicHost)) {
    console.log(`TURN:   ${env.turnHost || env.publicHost}:${env.turnPort}`)
  } else {
    console.log('TURN:   (não configurado — só STUN; ok em LAN)')
  }
  console.log('')
}

bootstrap().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
