// Shared clinic-day helpers used by booking, public tickets, the queue terminal, and CSV import.

const pad = value => String(value).padStart(2, '0');

function clinicDateString(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function clinicDateTime(date = new Date()) {
  return `${clinicDateString(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ticketNumber(number) {
  return `A${String(number).padStart(3, '0')}`;
}

// Accepts "YYYY-MM-DDTHH:MM" and returns it only when it names a real calendar date and time.
function parseLocalDateTime(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const parts = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!parts) return null;
  const [year, month, day, hour, minute] = parts.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  const valid =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute;
  return valid ? text : null;
}

// Ticket numbers never change after issue; queue_order is the mutable position used for skips.
function allocateQueueSlot(db, day) {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(queue_number), 0) + 1 AS number,
              COALESCE(MAX(COALESCE(queue_order, queue_number)), 0) + 1 AS position
       FROM appointments WHERE date(scheduled_at) = date(?)`
    )
    .get(day);
  return { queueNumber: row.number, queueOrder: row.position };
}

module.exports = { clinicDateString, clinicDateTime, ticketNumber, parseLocalDateTime, allocateQueueSlot };
