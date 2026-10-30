/*
 * Coach workout library — pure input handling. Rows belong to ONE coach
 * (coach_id); the endpoint always scopes by the authenticated coach and never
 * trusts an id sent by the client.
 */
import { SW } from "./structuredWorkout.js";

function text(value, max) {
  if (value == null) return "";
  const cleaned = String(value).replace(/[\u0000-\u001f]/g, " ").trim();
  return cleaned.slice(0, max);
}

export function sanitizeLibraryItem(input) {
  const raw = input && typeof input === "object" ? input : {};
  const name = text(raw.name, 120);
  if (!name) return { ok: false, error: "Give the workout a name." };
  const structure = SW.validate(raw.structure);
  if (!structure.ok) return { ok: false, error: structure.error };
  const resolved = SW.resolve(structure.value, null);
  return {
    ok: true,
    value: {
      name,
      folder: text(raw.folder, 80) || null,
      sport: "run",
      structure: structure.value,
      summary: {
        duration_minutes: resolved.totals.durationMinutes,
        steps: resolved.steps.length
      },
      notes: text(raw.notes, 600) || null
    }
  };
}

export function shapeLibraryRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    name: text(row.name, 120),
    folder: row.folder ? text(row.folder, 80) : null,
    structure: row.structure && typeof row.structure === "object" ? row.structure : null,
    summary: row.summary && typeof row.summary === "object" ? row.summary : null,
    notes: row.notes ? text(row.notes, 600) : null,
    updated_at: row.updated_at || null
  };
}
