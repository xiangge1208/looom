import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { DorisService } from '../database/doris.service'

export const PERMISSIONS_KEY = 'required_permissions'

/**
 * 声明接口需要的权限点。
 *
 * 用法：`@RequirePermissions('supplier:read')`，配合 JwtAuthGuard 一起用。
 * 不写这个装饰器的接口只需登录，不校验权限 —— 保持 P1/P2 的行为不变。
 */
export const RequirePermissions = (...perms: string[]) =>
  SetMetadata(PERMISSIONS_KEY, perms)

/**
 * 权限守卫
 *
 * 权限存在 roles.permissions 里，是个 JSON 数组字符串，如 `["query:read"]`，
 * 管理员是 `["*"]`（通配全部）。用户与角色多对多，取并集。
 *
 * ## 为什么每次请求都查库
 *
 * 权限没有放进 JWT。放进去的话，改权限必须等 token 过期（2h）才生效，
 * 或者维护一套吊销机制。查库虽然多一次往返，但改权限立刻生效，
 * 对这个量级的应用更合适。
 *
 * ⚠️ Doris 不适合高频点查（它是 OLAP 引擎）。当前只有供应商相关接口用到，
 * QPS 很低，可以接受。如果将来全站接口都要鉴权，应当加一层内存缓存
 * （按 userId 缓存几十秒），而不是继续每请求查库。
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DorisService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [ctx.getHandler(), ctx.getClass()],
    )

    // 没声明权限要求的接口直接放行（只要过了 JwtAuthGuard）
    if (!required?.length) return true

    const req = ctx.switchToHttp().getRequest()
    const userId = req.user?.id
    if (!userId) {
      // 正常不会走到这里 —— JwtAuthGuard 应该在前面拦住。
      // 但如果有人漏加 JwtAuthGuard，这里必须拒绝而不是放行。
      throw new ForbiddenException('未认证的请求')
    }

    const granted = await this.loadPermissions(String(userId))

    // '*' 通配一切
    if (granted.has('*')) return true

    const missing = required.filter((p) => !granted.has(p))
    if (missing.length) {
      throw new ForbiddenException(`缺少权限：${missing.join(', ')}`)
    }
    return true
  }

  /** 取用户所有角色的权限并集 */
  private async loadPermissions(userId: string): Promise<Set<string>> {
    const rows = await this.db.query<{ permissions: string | null }>(
      `SELECT r.permissions
         FROM user_roles ur
         JOIN \`roles\` r ON r.id = ur.role_id
        WHERE ur.user_id = ?`,
      [userId],
    )

    const set = new Set<string>()
    for (const row of rows) {
      if (!row.permissions) continue
      try {
        const arr = JSON.parse(row.permissions)
        if (Array.isArray(arr)) {
          for (const p of arr) if (typeof p === 'string') set.add(p)
        }
      } catch {
        // 权限字段不是合法 JSON 就跳过这条角色。
        // 不抛异常 —— 一个角色数据损坏不该让用户完全无法访问，
        // 但也绝不能因此放行（缺的权限自然会在上面被拒）。
      }
    }
    return set
  }
}
