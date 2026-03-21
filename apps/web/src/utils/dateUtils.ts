/**
 * 时间格式化工具函数
 * 数据库存储的是 UTC 时间，需要转换为 UTC+8（北京时间）显示
 */

/**
 * 将 UTC 时间戳转换为北京时间（UTC+8）
 * @param timestamp - UTC 时间戳（毫秒）
 * @returns 北京时间的时间戳（毫秒）
 */
function toBeijingTime(timestamp: number | string | Date): number {
  const ts = typeof timestamp === 'number' 
    ? timestamp 
    : typeof timestamp === 'string'
    ? new Date(timestamp).getTime()
    : timestamp.getTime();
  
  // 数据库存储的是 UTC 时间，需要加上8小时转换为北京时间
  // 8小时 = 8 * 60 * 60 * 1000 = 28800000 毫秒
  return ts + 28800000;
}

/**
 * 格式化时间为北京时间字符串（用于显示）
 * @param timestamp - UTC 时间戳（毫秒）或 Date 对象
 * @param options - Intl.DateTimeFormatOptions 选项
 * @returns 格式化后的时间字符串
 */
export function formatBeijingTime(
  timestamp: number | string | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  // 如果传入的是字符串或 Date，先转换为毫秒时间戳
  const ts = typeof timestamp === 'number' 
    ? timestamp 
    : typeof timestamp === 'string'
    ? new Date(timestamp).getTime()
    : timestamp.getTime();
  
  const date = new Date(ts);
  
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai', // 使用 Intl API 自动转换时区，不需要手动加8小时
    ...options
  };
  
  return date.toLocaleString('zh-CN', defaultOptions);
}

/**
 * 格式化时间为简短的北京时间字符串（用于列表显示）
 * @param timestamp - UTC 时间戳（毫秒）或 Date 对象
 * @returns 格式化后的时间字符串，例如：2024/12/22 14:30:25
 */
export function formatBeijingTimeShort(timestamp: number | string | Date): string {
  return formatBeijingTime(timestamp, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

/**
 * 格式化时间为文件名格式（YYYYMMDD_HHMMSS，使用北京时间）
 * @param timestamp - UTC 时间戳（毫秒）或 Date 对象
 * @returns 格式化后的时间字符串，例如：20241222_143025
 */
export function formatBeijingTimeForFileName(timestamp: number | string | Date): string {
  const beijingTimestamp = toBeijingTime(timestamp);
  const date = new Date(beijingTimestamp);
  
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

/**
 * 获取北京时间的 Date 对象
 * @param timestamp - UTC 时间戳（毫秒）或 Date 对象
 * @returns 北京时间的 Date 对象
 */
export function getBeijingDate(timestamp: number | string | Date): Date {
  const beijingTimestamp = toBeijingTime(timestamp);
  return new Date(beijingTimestamp);
}

/**
 * 将北京时间的日期字符串（YYYY-MM-DD）转换为 UTC 时间的开始时间（用于数据库查询）
 * @param dateStr - 北京时间的日期字符串，格式：YYYY-MM-DD
 * @returns UTC 时间的 ISO 字符串，例如：2024-12-21T16:00:00.000Z（对应北京时间 2024-12-22 00:00:00）
 */
export function beijingDateToUTCStart(dateStr: string): string {
  // 用户输入的日期是北京时间，需要减去8小时转换为 UTC
  // 例如：北京时间 2024-12-22 00:00:00 = UTC 2024-12-21 16:00:00
  const beijingDate = new Date(dateStr + 'T00:00:00+08:00');
  return beijingDate.toISOString();
}

/**
 * 将北京时间的日期字符串（YYYY-MM-DD）转换为 UTC 时间的结束时间（用于数据库查询）
 * @param dateStr - 北京时间的日期字符串，格式：YYYY-MM-DD
 * @returns UTC 时间的 ISO 字符串，例如：2024-12-22T15:59:59.999Z（对应北京时间 2024-12-22 23:59:59）
 */
export function beijingDateToUTCEnd(dateStr: string): string {
  // 用户输入的日期是北京时间，需要减去8小时转换为 UTC
  // 例如：北京时间 2024-12-22 23:59:59 = UTC 2024-12-22 15:59:59
  const beijingDate = new Date(dateStr + 'T23:59:59.999+08:00');
  return beijingDate.toISOString();
}
