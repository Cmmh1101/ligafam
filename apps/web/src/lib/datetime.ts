// A `datetime-local` input's value (e.g. "2026-08-15T18:00") has no zone but
// does contain a "T", so per spec `new Date(...)` parses it as local time --
// this direction needs no manual offset math.
export function toUtcIso(localValue: string): string {
  return new Date(localValue).toISOString();
}

// Reverse direction: build "YYYY-MM-DDTHH:mm" from a Date's LOCAL getters,
// not the UTC ones -- the easy place to reintroduce the same class of bug.
export function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatEventDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(iso));
}
