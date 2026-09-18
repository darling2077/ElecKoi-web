import { describe, expect, it } from 'vitest';
import { configDefaultModel } from '../src/renderer/src/modules/models/components/ModelPicker.jsx';

describe('model picker configuration selection', () => {
  it('activates the model saved on the selected configuration', () => {
    expect(configDefaultModel({
      id: 'config-a',
      model: 'model-saved',
      model_options: [{ id: 'model-other' }],
    }, {})).toBe('model-saved');
  });

  it('falls back to the first model when the configuration has no saved model', () => {
    expect(configDefaultModel({
      id: 'config-a',
      model: '',
      model_options: [{ id: 'model-first' }, { id: 'model-second' }],
    }, {})).toBe('model-first');
  });

  it('uses a refreshed model as the fallback without persisting the catalog', () => {
    expect(configDefaultModel({
      id: 'config-a',
      provider: 'custom',
      base_url: 'https://example.invalid',
      api_format: 'responses',
      model: '',
      model_options: [],
    }, {
      'config-a|custom|responses|https://example.invalid|': [{ id: 'model-refreshed' }],
    })).toBe('model-refreshed');
  });
});
