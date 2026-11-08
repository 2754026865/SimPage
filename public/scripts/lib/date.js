// Sunday starts a week; the week containing January 1 is week 1.
// UTC is used only for calendar arithmetic, retaining the user's local date.
export function getWeekNumber(date) {
  const year = date.getFullYear();
  const first = Date.UTC(year, 0, 1);
  const day = Date.UTC(year, date.getMonth(), date.getDate());
  return Math.floor(((day - first) / 86400000 + new Date(first).getUTCDay()) / 7) + 1;
}

export function createDailyCalendarCache({ formatDate, formatLunar }) {
  let key = "";
  let value;
  return (date) => {
    const nextKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getTimezoneOffset()}`;
    if (nextKey !== key) {
      key = nextKey;
      value = { date: formatDate(date), lunar: formatLunar(date), weekNum: getWeekNumber(date) };
    }
    return value;
  };
}
