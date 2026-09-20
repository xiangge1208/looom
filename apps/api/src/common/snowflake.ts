/**
 * 雪花算法 ID 生成器
 *
 * 为什么需要：Doris 没有自增主键，所有 ID 必须在应用层生成（goal.md 约束 2）。
 *
 * 64 位构成：
 *   1 位符号位（恒 0） + 41 位毫秒时间戳 + 10 位机器 ID + 12 位序列号
 *   → 同一毫秒内单机可生成 4096 个不重复 ID，可用到 2090 年左右。
 *
 * 注意：返回 bigint，写库时 mysql2 会正确处理为 BIGINT。
 * 传给前端时要转成 string —— JS number 精度只有 53 位，直接传数字会丢精度。
 */

const EPOCH = 1700000000000n // 2023-11-14，自定义纪元，让 41 位时间戳够用更久
const MACHINE_ID_BITS = 10n
const SEQUENCE_BITS = 12n

const MAX_MACHINE_ID = (1n << MACHINE_ID_BITS) - 1n
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n

const MACHINE_ID_SHIFT = SEQUENCE_BITS
const TIMESTAMP_SHIFT = SEQUENCE_BITS + MACHINE_ID_BITS

export class Snowflake {
  private lastTimestamp = -1n
  private sequence = 0n
  private readonly machineId: bigint

  constructor(machineId = 1) {
 const id = BigInt(machineId)
    if (id < 0n || id > MAX_MACHINE_ID) {
      throw new Error(`machineId 必须在 0~${MAX_MACHINE_ID} 之间，收到 ${machineId}`)
    }
    this.machineId = id
  }

  nextId(): bigint {
    let now = BigInt(Date.now())

    // 时钟回拨保护：宁可等，也不能发出重复 ID
    if (now < this.lastTimestamp) {
    const drift = this.lastTimestamp - now
      if (drift > 5000n) {
        throw new Error(`时钟回拨 ${drift}ms，超过容忍上限，拒绝生成 ID`)
      }
      while (now < this.lastTimestamp) {
        now = BigInt(Date.now())
      }
    }

    if (now === this.lastTimestamp) {
      this.sequence = (this.sequence + 1n) & MAX_SEQUENCE
      // 这一毫秒的 4096 个序号用完了，自旋等到下一毫秒
      if (this.sequence === 0n) {
        while (BigInt(Date.now()) <= this.lastTimestamp) {
          /* spin */
        }
        now = BigInt(Date.now())
      }
    } else {
      this.sequence = 0n
    }

    this.lastTimestamp = now

    return (
   ((now - EPOCH) << TIMESTAMP_SHIFT) |
 (this.machineId << MACHINE_ID_SHIFT) |
      this.sequence
    )
  }

  /** 返回字符串形式，用于 JSON 输出（避免 JS number 精度丢失） */
  nextIdStr(): string {
    return this.nextId().toString()
  }
}

/** 全局默认实例。多实例部署时应按实例序号传不同的 machineId */
export const snowflake = new Snowflake(
  Number(process.env.MACHINE_ID ?? 1),
)
