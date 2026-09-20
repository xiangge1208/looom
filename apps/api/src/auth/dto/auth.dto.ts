import { IsEmail, IsString, Length, Matches } from 'class-validator'

/**
 * 注册请求
 *
 * 密码规则沿用原站的正则（system 域侦察所得）：
 *   /^(?=.*[a-zA-Z])(?=.*[0-9])[a-zA-Z0-9]{6,20}$/
 *   即 6~20 位、必须同时含字母和数字、只允许字母数字。
 *
 * 注意：原站注册用手机号（payload 只有 {phone, password}），
 * goal.md 明确要求改用邮箱密码，不抄微信扫码流程。
 */
export class RegisterDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  email: string

  @IsString()
  @Length(6, 20, { message: '密码长度需为 6~20 位' })
  @Matches(/^(?=.*[a-zA-Z])(?=.*[0-9])[a-zA-Z0-9]{6,20}$/, {
    message: '密码需同时包含字母和数字，且只能使用字母与数字',
  })
  password: string

  @IsString()
  @Length(1, 32, { message: '昵称长度需为 1~32 位' })
  nickname: string
}

export class LoginDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  email: string

  @IsString()
  @Length(6, 20, { message: '密码长度需为 6~20 位' })
  password: string
}

export class RefreshDto {
  @IsString({ message: 'refreshToken 不能为空' })
  refreshToken: string
}
