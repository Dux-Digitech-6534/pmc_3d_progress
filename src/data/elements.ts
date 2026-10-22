import type { ElementRecord, ModelRecord } from '../domain/types';

export const modelKeyOf = (projectId: string, modelId: string, revision: string) => `${projectId}|${modelId}|${revision}`;

/** Resolve the elements of one model revision into application records with stable keys. */
export function elementsFromModel(record: ModelRecord): ElementRecord[] {
  const doc = record.document;
  if (!doc) return [];
  const buildings = new Map(doc.buildings.map((b) => [b.id, b.name]));
  const levels = new Map(doc.levels.map((l) => [l.id, l.name]));
  return doc.elements.map((e) => ({
    ...e,
    key: `${record.key}|${e.id}`,
    projectId: record.projectId,
    modelKey: record.key,
    modelId: record.modelId,
    modelRevision: record.revision,
    buildingName: buildings.get(e.buildingId) ?? e.buildingId,
    levelName: levels.get(e.levelId) ?? e.levelId,
  }));
}
