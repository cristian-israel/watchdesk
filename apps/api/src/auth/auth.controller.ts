import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { AuthService } from './auth.service'
import { UsersService, type UserRole } from './users.service'

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  @Post('auth/login')
  async login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { login?: string; password?: string },
  ) {
    const user = await this.users.authenticate(String(body?.login || ''), String(body?.password || ''))
    if (!user) throw new HttpException('Login ou senha inválidos.', 401)
    const publicUser = await this.auth.login(res, req, user)
    return { ok: true, user: publicUser }
  }

  @Post('auth/logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req, res)
    return { ok: true }
  }

  @Get('auth/me')
  async me(@Req() req: Request) {
    const user = await this.auth.userFromRequest(req)
    if (!user) return { ok: false, user: null }
    return { ok: true, user: this.users.publicUser(user) }
  }

  @Get('admin/users')
  async listUsers(@Req() req: Request) {
    await this.ensureAdmin(req)
    return { users: await this.users.listUsers() }
  }

  @Post('admin/users')
  async createUser(
    @Req() req: Request,
    @Body() body: { login?: string; password?: string; displayName?: string; role?: string },
  ) {
    await this.ensureAdmin(req)
    try {
      const row = await this.users.createUser({
        login: String(body?.login || ''),
        password: String(body?.password || ''),
        displayName: String(body?.displayName || ''),
        role: body?.role === 'admin' ? 'admin' : 'user',
      })
      return { ok: true, user: this.users.publicUser(row) }
    } catch (e: unknown) {
      throw this.mapUserError(e)
    }
  }

  @Patch('admin/users/:id')
  async patchUser(
    @Req() req: Request,
    @Param('id') idParam: string,
    @Body()
    body: {
      displayName?: string
      password?: string
      role?: string
      active?: boolean
    },
  ) {
    const admin = await this.ensureAdmin(req)
    const id = Number(idParam)
    if (!Number.isInteger(id) || id < 1) throw new HttpException('Usuário inválido.', 400)
    if (id === admin.id && body.active === false) {
      throw new HttpException('Não é possível desativar a si mesmo.', 400)
    }
    try {
      const role: UserRole | undefined =
        body.role === undefined ? undefined : body.role === 'admin' ? 'admin' : 'user'
      const row = await this.users.updateUser(id, {
        displayName: body.displayName,
        password: body.password,
        role,
        active: body.active,
      })
      return { ok: true, user: this.users.publicUser(row) }
    } catch (e: unknown) {
      throw this.mapUserError(e)
    }
  }

  @Patch('auth/me')
  async patchMe(
    @Req() req: Request,
    @Body() body: { displayName?: string; password?: string },
  ) {
    const user = await this.auth.userFromRequest(req)
    if (!user) throw new HttpException('Faça login.', 401)
    try {
      const row = await this.users.updateUser(user.id, {
        displayName: body.displayName,
        password: body.password,
      })
      return { ok: true, user: this.users.publicUser(row) }
    } catch (e: unknown) {
      throw this.mapUserError(e)
    }
  }

  @Delete('admin/users/:id')
  async deleteUser(@Req() req: Request, @Param('id') idParam: string) {
    const admin = await this.ensureAdmin(req)
    const id = Number(idParam)
    if (!Number.isInteger(id) || id < 1) throw new HttpException('Usuário inválido.', 400)
    if (id === admin.id) throw new HttpException('Não é possível excluir a si mesmo.', 400)
    try {
      await this.users.deleteUser(id)
      return { ok: true }
    } catch (e: unknown) {
      throw this.mapUserError(e)
    }
  }

  private async ensureAdmin(req: Request) {
    try {
      return await this.auth.requireAdmin(req)
    } catch (e: unknown) {
      const err = e as { message?: string; status?: number }
      if (err.message === 'unauthorized') throw new HttpException('Faça login.', 401)
      throw new HttpException('Só admin.', 403)
    }
  }

  private mapUserError(e: unknown): HttpException {
    const err = e as { message?: string }
    switch (err.message) {
      case 'login_invalid':
        return new HttpException(
          'Login inválido (3–254: apelido ou e-mail, com letras, números, . _ + - e @).',
          400,
        )
      case 'login_taken':
        return new HttpException('Login já existe.', 409)
      case 'name_invalid':
        return new HttpException('Apelido: 2 a 32 caracteres.', 400)
      case 'password_invalid':
        return new HttpException('Senha deve ter ao menos 4 caracteres.', 400)
      case 'not_found':
        return new HttpException('Usuário não encontrado.', 404)
      case 'last_admin':
        return new HttpException('Não é possível remover o último admin ativo.', 400)
      default:
        if (e instanceof HttpException) return e
        return new HttpException('Não foi possível salvar o usuário.', 400)
    }
  }
}
