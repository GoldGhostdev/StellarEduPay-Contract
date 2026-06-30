'use strict';

// Isolate prom-client registry so tests don't conflict with the app's registry
jest.mock('../src/metrics/index', () => {
  const client = require('prom-client');
  const registry = new client.Registry();
  return { registry };
});

jest.mock('../src/models/webhookDeliveryModel', () => ({
  aggregate: jest.fn().mockResolvedValue([]),
}));

const {
  webhookDeliveriesTotal,
  webhookDeliveryDurationMs,
  webhookDeadLetterTotal,
  recordDeliverySuccess,
  recordDeliveryFailure,
  refreshDeadLetterGauge,
} = require('../src/metrics/webhookMetrics');

const WebhookDelivery = require('../src/models/webhookDeliveryModel');

beforeEach(() => {
  webhookDeliveriesTotal.reset();
  webhookDeliveryDurationMs.reset();
  webhookDeadLetterTotal.reset();
  jest.clearAllMocks();
});

describe('recordDeliverySuccess', () => {
  test('increments webhook_deliveries_total with outcome=success', async () => {
    recordDeliverySuccess('payment.confirmed', 123);
    const metrics = await webhookDeliveriesTotal.get();
    const val = metrics.values.find(
      (v) => v.labels.event === 'payment.confirmed' && v.labels.outcome === 'success'
    );
    expect(val).toBeDefined();
    expect(val.value).toBe(1);
  });

  test('observes duration histogram', async () => {
    recordDeliverySuccess('payment.pending', 456);
    const metrics = await webhookDeliveryDurationMs.get();
    const sampleCount = metrics.values.find(
      (v) => v.labels.event === 'payment.pending' && v.metricName === 'webhook_delivery_duration_ms_count'
    );
    expect(sampleCount).toBeDefined();
    expect(sampleCount.value).toBeGreaterThan(0);
  });
});

describe('recordDeliveryFailure', () => {
  test('increments webhook_deliveries_total with outcome=failure', async () => {
    recordDeliveryFailure('payment.failed', 200, false, null);
    const metrics = await webhookDeliveriesTotal.get();
    const val = metrics.values.find(
      (v) => v.labels.event === 'payment.failed' && v.labels.outcome === 'failure'
    );
    expect(val).toBeDefined();
    expect(val.value).toBe(1);
  });

  test('increments dead-letter gauge when isDeadLetter=true', async () => {
    recordDeliveryFailure('payment.confirmed', 100, true, 'SCH-1');
    const metrics = await webhookDeadLetterTotal.get();
    const val = metrics.values.find((v) => v.labels.schoolId === 'SCH-1');
    expect(val).toBeDefined();
    expect(val.value).toBe(1);
  });

  test('does not increment dead-letter gauge when isDeadLetter=false', async () => {
    recordDeliveryFailure('payment.confirmed', 100, false, 'SCH-2');
    const metrics = await webhookDeadLetterTotal.get();
    const val = metrics.values.find((v) => v.labels.schoolId === 'SCH-2');
    expect(val).toBeUndefined();
  });

  test('observes duration histogram on failure', async () => {
    recordDeliveryFailure('payment.suspicious', 999, false, null);
    const metrics = await webhookDeliveryDurationMs.get();
    const sampleCount = metrics.values.find(
      (v) => v.labels.event === 'payment.suspicious' && v.metricName === 'webhook_delivery_duration_ms_count'
    );
    expect(sampleCount).toBeDefined();
    expect(sampleCount.value).toBeGreaterThan(0);
  });
});

describe('refreshDeadLetterGauge', () => {
  test('sets gauge from DB aggregate result', async () => {
    WebhookDelivery.aggregate.mockResolvedValue([
      { _id: 'SCH-3', count: 5 },
      { _id: 'SCH-4', count: 2 },
    ]);
    await refreshDeadLetterGauge();
    const metrics = await webhookDeadLetterTotal.get();
    const sch3 = metrics.values.find((v) => v.labels.schoolId === 'SCH-3');
    const sch4 = metrics.values.find((v) => v.labels.schoolId === 'SCH-4');
    expect(sch3.value).toBe(5);
    expect(sch4.value).toBe(2);
  });

  test('does not throw when DB aggregate fails', async () => {
    WebhookDelivery.aggregate.mockRejectedValue(new Error('DB down'));
    await expect(refreshDeadLetterGauge()).resolves.not.toThrow();
  });
});
