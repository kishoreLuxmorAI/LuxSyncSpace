export function isHoliday(date = new Date(), events = []) {
  const m = date.getMonth() + 1; // 1-12
  const d = date.getDate(); // 1-31
  const day = date.getDay(); // 0-6 (0 is Sunday, 6 is Saturday)

  // Standard recognized public / corporate holidays:
  // Jan 1: New Year's Day
  if (m === 1 && d === 1) return true;
  // Jan 26: Republic Day
  if (m === 1 && d === 26) return true;
  // MLK Day: 3rd Monday in Jan (between Jan 15 and 21)
  if (m === 1 && day === 1 && d >= 15 && d <= 21) return true;
  // Presidents' Day: 3rd Monday in Feb (between Feb 15 and 21)
  if (m === 2 && day === 1 && d >= 15 && d <= 21) return true;
  // Memorial Day: Last Monday in May (between May 25 and 31)
  if (m === 5 && day === 1 && d >= 25) return true;
  // Juneteenth: June 19
  if (m === 6 && d === 19) return true;
  // US Independence Day: July 4
  if (m === 7 && d === 4) return true;
  // India Independence Day: August 15
  if (m === 8 && d === 15) return true;
  // Labor Day: 1st Monday in September (between Sep 1 and 7)
  if (m === 9 && day === 1 && d <= 7) return true;
  // Gandhi Jayanti: October 2
  if (m === 10 && d === 2) return true;
  // Veterans Day: November 11
  if (m === 11 && d === 11) return true;
  // Thanksgiving: 4th Thursday in November (between Nov 22 and 28)
  if (m === 11 && day === 4 && d >= 22 && d <= 28) return true;
  // Day after Thanksgiving (Black Friday)
  if (m === 11 && day === 5 && d >= 23 && d <= 29) return true;
  // Christmas Eve: December 24
  if (m === 12 && d === 24) return true;
  // Christmas Day: December 25
  if (m === 12 && d === 25) return true;
  // New Year's Eve: December 31
  if (m === 12 && d === 31) return true;

  // Check calendar events matching holiday keywords for this date
  if (Array.isArray(events) && events.length > 0) {
    const dateStr = date.toISOString().slice(0, 10);
    const hasHolidayEvent = events.some((evt) => {
      const startStr = evt.starts_at ? new Date(evt.starts_at).toISOString().slice(0, 10) : "";
      const text = `${evt.title || ""} ${evt.description || ""}`.toLowerCase();
      const isDateMatch = !evt.starts_at || startStr === dateStr;
      return isDateMatch && (
        text.includes("holiday") ||
        text.includes("office closed") ||
        text.includes("day off") ||
        text.includes("vacation") ||
        text.includes("company off")
      );
    });
    if (hasHolidayEvent) return true;
  }

  return false;
}

export function getScheduleInfo(date = new Date(), events = []) {
  const day = date.getDay();
  const isWeekend = day === 0 || day === 6;
  const hour = date.getHours();
  const isOffHours = hour < 9 || hour >= 18;
  const holiday = isHoliday(date, events);
  const isWorkingSchedule = !isWeekend && !isOffHours && !holiday;

  return {
    isWeekend,
    isOffHours,
    isHoliday: holiday,
    isWorkingSchedule,
    isOffSchedule: !isWorkingSchedule
  };
}

export function resolveUserPresence(user, options = {}) {
  const now = options.now || new Date();
  const status = user.availability_status || user.presence || "offline";

  // Explicit user manual statuses are preserved
  if (["meeting", "lunch", "break", "unavailable", "offline"].includes(status)) {
    return {
      availability_status: status,
      presence: status === "offline" ? "offline" : status === "unavailable" ? "busy" : "away"
    };
  }

  const schedule = getScheduleInfo(now, options.events || []);
  const lastActive = user.last_active_at ? new Date(user.last_active_at) : new Date(0);
  const idleMinutes = (now.getTime() - lastActive.getTime()) / 60000;

  // During off-schedule (weekends, holidays, off-hours)
  if (schedule.isOffSchedule) {
    // If user has been inactive for more than 2 minutes outside working schedule, mark Away
    if (idleMinutes > 2) {
      return { availability_status: "away", presence: "away" };
    }
  } else {
    // During standard working hours, 5 minutes idle threshold
    if (idleMinutes > 5) {
      return { availability_status: "away", presence: "away" };
    }
  }

  return {
    availability_status: status,
    presence: user.presence || "online"
  };
}
