/**
 * Standard business schedule and holiday evaluator.
 * Working days: Monday - Friday
 * Working hours: 09:00 - 18:00 (local/standard)
 */
export function getScheduleInfo(date = new Date()) {
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday
  const isWeekend = day === 0 || day === 6;
  
  const hour = date.getHours();
  const isWorkingHours = hour >= 9 && hour < 18;
  const isOffHours = !isWorkingHours;

  // Recognized public/standard company holidays (MM-DD)
  const monthDay = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const standardHolidays = new Set([
    "01-01", // New Year's Day
    "01-26", // Republic Day
    "05-01", // Labor Day
    "08-15", // Independence Day
    "10-02", // Gandhi Jayanti
    "12-25"  // Christmas Day
  ]);
  const isHoliday = standardHolidays.has(monthDay);
  const isOffSchedule = isWeekend || isHoliday || isOffHours;

  return {
    isWeekend,
    isHoliday,
    isOffHours,
    isOffSchedule
  };
}
