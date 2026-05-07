/**
 * 农历计算工具
 * 支持 1900-2100 年的公历转农历
 */

// 农历数据表 (1900-2100)
const lunarInfo = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
  0x0d520,
];

const Gan = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const Zhi = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const Animals = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
const solarMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const lunarMonthName = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
const lunarDayName = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
];

/**
 * 判断是否为闰年
 */
function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * 获取农历年份的闰月，0 表示无闰月
 */
function leapMonth(year) {
  return lunarInfo[year - 1900] & 0xf;
}

/**
 * 获取农历年份闰月的天数
 */
function leapDays(year) {
  if (leapMonth(year)) {
    return lunarInfo[year - 1900] & 0x10000 ? 30 : 29;
  }
  return 0;
}

/**
 * 获取农历年份的总天数
 */
function yearDays(year) {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) {
    sum += lunarInfo[year - 1900] & i ? 1 : 0;
  }
  return sum + leapDays(year);
}

/**
 * 获取农历年份某月的天数
 */
function monthDays(year, month) {
  return lunarInfo[year - 1900] & (0x10000 >> month) ? 30 : 29;
}

/**
 * 获取天干地支年份
 */
function cyclical(year) {
  const num = year - 1900 + 36;
  return Gan[num % 10] + Zhi[num % 12];
}

/**
 * 获取生肖
 */
function getAnimal(year) {
  return Animals[(year - 1900) % 12];
}

/**
 * 公历转农历
 * @param {Date} date - 公历日期对象
 * @returns {Object} 农历信息对象
 */
export function solarToLunar(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  // 基准日期：1900年1月31日，农历1900年正月初一
  let offset = 0;
  
  // 计算距离1900年1月31日的天数
  for (let i = 1900; i < year; i++) {
    offset += isLeapYear(i) ? 366 : 365;
  }
  
  for (let i = 1; i < month; i++) {
    offset += solarMonth[i - 1];
  }
  
  if (month > 2 && isLeapYear(year)) {
    offset += 1;
  }
  
  offset += day - 31;

  // 计算农历年份
  let lunarYear = 1900;
  let daysInYear = 0;
  
  while (lunarYear < 2101 && offset > 0) {
    daysInYear = yearDays(lunarYear);
    offset -= daysInYear;
    lunarYear++;
  }
  
  if (offset < 0) {
    offset += daysInYear;
    lunarYear--;
  }

  // 计算农历月份和日期
  const leap = leapMonth(lunarYear);
  let isLeap = false;
  let lunarMonth = 1;
  
  while (lunarMonth < 13 && offset > 0) {
    if (leap > 0 && lunarMonth === leap + 1 && !isLeap) {
      lunarMonth--;
      isLeap = true;
      daysInYear = leapDays(lunarYear);
    } else {
      daysInYear = monthDays(lunarYear, lunarMonth);
    }
    
    offset -= daysInYear;
    
    if (isLeap && lunarMonth === leap + 1) {
      isLeap = false;
    }
    
    lunarMonth++;
  }
  
  if (offset === 0 && leap > 0 && lunarMonth === leap + 1) {
    if (isLeap) {
      isLeap = false;
    } else {
      isLeap = true;
      lunarMonth--;
    }
  }
  
  if (offset < 0) {
    offset += daysInYear;
    lunarMonth--;
  }
  
  const lunarDay = offset + 1;

  return {
    year: lunarYear,
    month: lunarMonth,
    day: lunarDay,
    isLeap: isLeap,
    yearCyl: cyclical(lunarYear),
    animal: getAnimal(lunarYear),
    monthName: (isLeap ? '闰' : '') + lunarMonthName[lunarMonth - 1] + '月',
    dayName: lunarDayName[lunarDay - 1],
  };
}

/**
 * 格式化农历日期
 * @param {Date} date - 公历日期对象
 * @returns {string} 格式化后的农历字符串
 */
export function formatLunar(date) {
  const lunar = solarToLunar(date);
  return `农历${lunar.yearCyl}年${lunar.monthName}${lunar.dayName}`;
}
