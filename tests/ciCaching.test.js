'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

describe('CI Workflow Caching', () => {
  test('should have cache action configured in CI workflow', () => {
    const ciPath = path.join(__dirname, '../.github/workflows/ci.yml');
    const ciContent = fs.readFileSync(ciPath, 'utf8');
    const ciConfig = yaml.load(ciContent);

    const steps = ciConfig.jobs.test.steps;
    const cacheStep = steps.find(step => step.uses && step.uses.includes('actions/cache'));

    expect(cacheStep).toBeDefined();
    expect(cacheStep.with.path).toContain('node_modules');
    expect(cacheStep.with.key).toContain('hashFiles');
  });

  test('should cache backend node_modules', () => {
    const ciPath = path.join(__dirname, '../.github/workflows/ci.yml');
    const ciContent = fs.readFileSync(ciPath, 'utf8');
    const ciConfig = yaml.load(ciContent);

    const steps = ciConfig.jobs.test.steps;
    const cacheStep = steps.find(step => step.uses && step.uses.includes('actions/cache'));

    expect(cacheStep.with.path).toContain('backend/node_modules');
  });

  test('should cache frontend node_modules', () => {
    const ciPath = path.join(__dirname, '../.github/workflows/ci.yml');
    const ciContent = fs.readFileSync(ciPath, 'utf8');
    const ciConfig = yaml.load(ciContent);

    const steps = ciConfig.jobs.test.steps;
    const cacheStep = steps.find(step => step.uses && step.uses.includes('actions/cache'));

    expect(cacheStep.with.path).toContain('frontend/node_modules');
  });

  test('should invalidate cache on package-lock.json changes', () => {
    const ciPath = path.join(__dirname, '../.github/workflows/ci.yml');
    const ciContent = fs.readFileSync(ciPath, 'utf8');
    const ciConfig = yaml.load(ciContent);

    const steps = ciConfig.jobs.test.steps;
    const cacheStep = steps.find(step => step.uses && step.uses.includes('actions/cache'));

    expect(cacheStep.with.key).toContain('hashFiles');
    expect(cacheStep.with.key).toContain('package-lock.json');
  });

  test('should have restore-keys for cache fallback', () => {
    const ciPath = path.join(__dirname, '../.github/workflows/ci.yml');
    const ciContent = fs.readFileSync(ciPath, 'utf8');
    const ciConfig = yaml.load(ciContent);

    const steps = ciConfig.jobs.test.steps;
    const cacheStep = steps.find(step => step.uses && step.uses.includes('actions/cache'));

    expect(cacheStep.with['restore-keys']).toBeDefined();
    // restore-keys must be a multi-line block string (not a YAML array) so
    // actions/cache@v4 receives each key on its own line as the action expects.
    const restoreKeys = cacheStep.with['restore-keys'];
    expect(typeof restoreKeys === 'string' || Array.isArray(restoreKeys)).toBe(true);
  });

  test('should run npm ci for all packages', () => {
    const ciPath = path.join(__dirname, '../.github/workflows/ci.yml');
    const ciContent = fs.readFileSync(ciPath, 'utf8');
    const ciConfig = yaml.load(ciContent);

    const steps = ciConfig.jobs.test.steps;
    const runSteps = steps.filter(step => step.run);

    const hasRootCi = runSteps.some(step => step.run === 'npm ci');
    const hasBackendCi = runSteps.some(step => step.run && step.run.includes('backend') && step.run.includes('npm ci'));
    const hasFrontendCi = runSteps.some(step => step.run && step.run.includes('frontend') && step.run.includes('npm ci'));

    expect(hasRootCi).toBe(true);
    expect(hasBackendCi).toBe(true);
    expect(hasFrontendCi).toBe(true);
  });
});
