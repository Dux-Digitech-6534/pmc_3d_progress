import cabinA from './samples/security-cabin-a.json';
import cabinB from './samples/security-cabin-b.json';

/** Bundled sample model files. They go through exactly the same import pipeline as an uploaded file. */
export const SAMPLE_MODELS = [
  { id: 'a', fileName: 'security-cabin-a.json', label: 'Security Cabin A (R01)', projectId: 'PMC-SEC-001', json: cabinA },
  { id: 'b', fileName: 'security-cabin-b.json', label: 'Security Cabin B (R01)', projectId: 'PMC-SEC-002', json: cabinB },
] as const;

export const sampleText = (json: unknown) => JSON.stringify(json, null, 2);

/** A deliberately broken file so users can see validation errors without crafting one. */
export function invalidSampleText() {
  const doc = JSON.parse(JSON.stringify(cabinA));
  doc.model.revision = 'R99-INVALID';
  doc.elements[1].id = doc.elements[0].id; // duplicate stable id
  doc.elements[2].type = 'staircase'; // unsupported type
  doc.elements[3].geometry.size = [1.2, -0.4, 1.2]; // negative dimension
  doc.elements[4].plannedQuantities.CONC.unit = 'kg'; // unit mismatch
  delete doc.elements[5].levelId; // missing metadata
  return JSON.stringify(doc, null, 2);
}
