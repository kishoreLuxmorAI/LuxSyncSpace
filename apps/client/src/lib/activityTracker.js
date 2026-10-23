import { api } from "./api";
import { getScheduleInfo } from "./schedule";

/**
 * Starts automatic tracking of user activity, screen lock, and working schedule.
 *
 * @param {Object} options
 * @param {Object} options.user Current user object
 * @param {Array} options.events Organization calendar events
 * @param {Function} options.onStatusChange Function to update status in App state & backend
 * @returns {Function} Cleanup function to stop tracking
 */
export function startUserActivityTracker({ user, events = [], getUser, getEvents, onStatusChange }) {
  let lastActivity = Date.now();
  let isAutoAway = false;
  let isManualStatus = false;
  let hiddenSince = null;
  let heartbeatTimer = null;
  let checkInterval = null;
  let lockTimer = null;

  const currentUser = () => (typeof getUser === "function" ? getUser() : user);
  const currentEvents = () => (typeof getEvents === "function" ? getEvents() : events);

  // Manual statuses that should never be overridden automatically by user activity
  const MANUAL_STATUSES = new Set(["break", "lunch", "unavailable", "meeting", "offline"]);

  // Check if current user has an explicit manual status
  const initialStatus = currentUser()?.availability_status || currentUser()?.presence || "online";
  if (MANUAL_STATUSES.has(initialStatus)) {
    isManualStatus = true;
  }

  // Periodic heartbeat while active (every 60s)
  function sendHeartbeat() {
    if (document.visibilityState === "visible") {
      api("/presence/heartbeat", { method: "POST" }).catch(() => {});
    }
  }

  // Handle activity detected
  function onUserActive() {
    lastActivity = Date.now();

    // If user was locked or hidden, clear hidden state
    if (document.visibilityState === "visible") {
      hiddenSince = null;
    }

    // If currently in a manual status (lunch, break, meeting, etc.), do not override
    if (isManualStatus) {
      return;
    }

    const u = currentUser();
    const currentStatus = u?.availability_status || u?.presence;
    const schedule = getScheduleInfo(new Date(), currentEvents());

    // If the user was auto-transitioned to away, or is away and now active
    if (currentStatus === "away" && isAutoAway) {
      if (schedule.isWorkingSchedule) {
        isAutoAway = false;
        onStatusChange?.("online");
      }
    }
  }

  // Throttled event handler for user input
  let throttleTimer = null;
  function handleInputEvent() {
    if (throttleTimer) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      onUserActive();
    }, 1000);
  }

  // Check activity, idle status, and schedule
  function checkScheduleAndInactivity() {
    const now = new Date();
    const nowMs = now.getTime();
    const schedule = getScheduleInfo(now, currentEvents());
    const u = currentUser();
    const currentStatus = u?.availability_status || u?.presence;

    // Do not alter explicit manual statuses
    if (MANUAL_STATUSES.has(currentStatus)) {
      return;
    }

    // Determine idle threshold:
    // Regular working hours: 5 minutes (300,000 ms)
    // Weekends / holidays / off-hours: 2 minutes (120,000 ms)
    const idleLimitMs = schedule.isOffSchedule ? 2 * 60_000 : 5 * 60_000;
    const isInactive = (nowMs - lastActivity) >= idleLimitMs;
    const isLocked = document.visibilityState === "hidden" && hiddenSince && (nowMs - hiddenSince >= 30_000);

    // Transition to Away if:
    // 1. User has been inactive for the defined period
    // 2. System is locked / tab hidden for 30s
    // 3. Current time is weekend or holiday, and user is not actively interacting
    if (currentStatus === "online") {
      if (isInactive || isLocked || (schedule.isOffSchedule && (nowMs - lastActivity >= 60_000))) {
        isAutoAway = true;
        onStatusChange?.("away");
      }
    } else if (currentStatus === "away" && isAutoAway && !isInactive && !isLocked && schedule.isWorkingSchedule) {
      // Restore to online if user is active during working schedule
      isAutoAway = false;
      onStatusChange?.("online");
    }
  }

  // Screen lock / visibility change handler
  function handleVisibilityChange() {
    if (document.visibilityState === "hidden") {
      hiddenSince = Date.now();
      // When screen is locked, schedule transition to away
      if (lockTimer) clearTimeout(lockTimer);
      lockTimer = setTimeout(() => {
        const u = currentUser();
        const currentStatus = u?.availability_status || u?.presence;
        if (currentStatus === "online" && !isManualStatus) {
          isAutoAway = true;
          onStatusChange?.("away");
        }
      }, 30_000);
    } else {
      if (lockTimer) clearTimeout(lockTimer);
      hiddenSince = null;
      onUserActive();
    }
  }

  // Register user interaction listeners
  const activityEvents = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "wheel"];
  activityEvents.forEach((evt) => {
    window.addEventListener(evt, handleInputEvent, { passive: true });
  });
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("focus", onUserActive);

  // Set intervals
  checkInterval = setInterval(checkScheduleAndInactivity, 15_000);
  heartbeatTimer = setInterval(sendHeartbeat, 60_000);

  // Initial check upon mounting
  checkScheduleAndInactivity();

  // Return function to notify manual status changes and cleanup
  return {
    notifyManualStatus(status) {
      if (status === "online") {
        isManualStatus = false;
        isAutoAway = false;
        lastActivity = Date.now();
      } else {
        isManualStatus = true;
        isAutoAway = false;
      }
    },
    stop() {
      activityEvents.forEach((evt) => {
        window.removeEventListener(evt, handleInputEvent);
      });
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", onUserActive);
      if (checkInterval) clearInterval(checkInterval);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (lockTimer) clearTimeout(lockTimer);
      if (throttleTimer) clearTimeout(throttleTimer);
    }
  };
}
