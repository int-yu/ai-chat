export function normalizeModelsResponse(payload) {
  return Array.isArray(payload?.data) ? payload.data : [];
}

export function filterGrokModels(models = []) {
  const seen = new Set();
  return models.filter((model) => {
    const id = typeof model?.id === 'string' ? model.id.trim() : '';
    const normalizedId = id.toLowerCase();
    if (!normalizedId.includes('grok') || seen.has(normalizedId)) {
      return false;
    }
    seen.add(normalizedId);
    return true;
  });
}
