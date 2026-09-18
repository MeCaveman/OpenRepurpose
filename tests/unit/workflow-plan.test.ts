import { describe, expect, it } from 'vitest';
import {
  compileWorkflowExecutionPlan,
  validateWorkflowDefinition,
  type WorkflowDefinition,
} from '@openrepurpose/core';

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  steps: [
    { id: 'source', kind: 'source', sourceType: 'watched_folder' },
    { id: 'transform', kind: 'transform', operation: 'pass_through' },
    {
      id: 'destination',
      kind: 'destination',
      destination: { destinationId: 'youtube', accountId: 'account-1', privacy: 'private' },
    },
  ],
  edges: [
    { from: 'source', to: 'transform' },
    { from: 'transform', to: 'destination' },
  ],
};

describe('workflow execution plans', () => {
  it('compiles only a validated typed graph into the versioned plan format', () => {
    const plan = compileWorkflowExecutionPlan({
      definition,
      id: 'workflow-1',
      name: 'Upload',
      titleTemplate: '{{file.stem}}',
      descriptionTemplate: '',
      failurePolicy: 'best_effort',
    });
    expect(plan).toMatchObject({
      planVersion: 'workflow-plan-v1',
      definitionVersion: 1,
      destinations: [{ destinationId: 'youtube', accountId: 'account-1' }],
      steps: definition.steps,
    });
  });

  it.each([
    [
      'a cycle',
      {
        ...definition,
        edges: [
          { from: 'source', to: 'transform' },
          { from: 'transform', to: 'source' },
        ],
      },
    ],
    ['a disconnected destination', { ...definition, edges: [{ from: 'source', to: 'transform' }] }],
    [
      'an unsupported ordering',
      {
        ...definition,
        edges: [
          { from: 'source', to: 'destination' },
          { from: 'destination', to: 'transform' },
        ],
      },
    ],
  ] as const)('rejects %s', (_label, invalid) => {
    expect(() => validateWorkflowDefinition(invalid)).toThrow();
  });
});
